import { io } from "socket.io-client";
import { deriveRoomKeys, seal, open } from "./crypto";

/**
 * One call: the signaling socket plus a full mesh of peer connections.
 *
 * Trust model
 *  - The server only routes sealed blobs. Each signaling message is encrypted
 *    with the room key and bound to (room, sender, recipient, sequence number),
 *    so the server cannot read, forge, re-route or replay it.
 *  - Media, chat and annotations travel peer-to-peer over DTLS-SRTP / SCTP.
 *    The DTLS fingerprints are exchanged inside the sealed signaling, which is
 *    what makes the transport end-to-end authenticated.
 *  - A participant is only shown once they have produced a valid sealed
 *    message, i.e. proved they hold the invite code.
 *
 * Emits: "update" (any state change), "chat" (new message), "anno" (strokes
 * changed) and "toast" (short notice for the user).
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;
const ICE_SERVERS = parseIceServers(import.meta.env.VITE_ICE_SERVERS);

const MAX_NAME = 32;
const MAX_CHAT = 2000;
const MAX_MESSAGES = 5000;
const MAX_STROKES = 400;
const MAX_POINTS = 6000;
const MAX_DC_MESSAGE = 64 * 1024;
const UNVERIFIED_TIMEOUT = 30_000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function parseIceServers(raw) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn("VITE_ICE_SERVERS is not valid JSON; using the default STUN server.");
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

export function cleanName(value) {
  if (typeof value !== "string") return "Guest";
  // Strip control characters so a name cannot break layout or exported files.
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  return name || "Guest";
}

const unit = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);

export class RoomClient extends EventTarget {
  status = "connecting"; // connecting | joined | reconnecting | error | left
  error = null; // full | locked | rate | invalid | unsupported
  offline = false;
  selfId = null;
  locked = false;
  maxSize = 4;
  peers = new Map();
  messages = [];
  strokes = new Map();
  screenStream = null;

  #keys = null;
  #socket = null;
  #annoSession = null;
  #strokeSeq = 0;

  constructor({ code, name, media }) {
    super();
    this.code = code;
    this.name = cleanName(name);
    this.media = media;
    this.media.addEventListener("change", this.#onMediaChange);
  }

  /* ---------------------------------------------------------------- setup */

  async connect() {
    try {
      this.#keys = await deriveRoomKeys(this.code);
    } catch {
      return this.#fail("unsupported");
    }
    if (this.status === "left") return;

    const socket = io(SERVER_URL, { transports: ["websocket", "polling"] });
    this.#socket = socket;

    socket.on("connect", () => {
      this.offline = false;
      this.#join();
    });
    socket.on("connect_error", () => {
      this.offline = true;
      this.#update();
    });
    socket.on("disconnect", (reason) => {
      if (this.status === "left" || this.status === "error") return;
      // Peers were told we left, so every connection has to be rebuilt.
      this.#closeAllPeers();
      this.selfId = null;
      this.status = "reconnecting";
      this.#update();
      if (reason === "io server disconnect") socket.connect();
    });
    socket.on("peer-joined", ({ id }) => this.#addPeer(id));
    socket.on("peer-left", ({ id }) => this.#removePeer(id));
    socket.on("locked", ({ locked }) => {
      this.locked = !!locked;
      this.#update();
    });
    socket.on("signal", ({ from, data }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      // Handle strictly in arrival order; decryption is async.
      peer.inbox = peer.inbox.then(() => this.#onSignal(peer, data)).catch(() => {});
    });
  }

  #join() {
    this.#socket.emit("join", { roomId: this.#keys.roomId }, (res) => {
      if (this.status === "left") return;
      if (!res?.ok) return this.#fail(res?.error || "invalid");
      this.selfId = res.id;
      this.locked = !!res.locked;
      this.maxSize = res.max || this.maxSize;
      this.status = "joined";
      this.error = null;
      for (const id of res.peers) this.#addPeer(id);
      this.#update();
    });
  }

  #fail(error) {
    this.status = "error";
    this.error = error;
    this.#closeAllPeers();
    this.#socket?.disconnect();
    this.#update();
  }

  leave() {
    if (this.status === "left") return;
    this.status = "left";
    this.media.removeEventListener("change", this.#onMediaChange);
    this.#stopScreenTracks();
    this.#closeAllPeers();
    if (this.#socket) {
      this.#socket.emit("leave");
      this.#socket.disconnect();
    }
    this.#update();
  }

  setLocked(locked) {
    this.#socket?.emit("lock", { locked: !!locked });
  }

  /* ---------------------------------------------------------------- peers */

  get visiblePeers() {
    return [...this.peers.values()].filter((p) => p.verified);
  }

  #addPeer(id) {
    if (typeof id !== "string" || id === this.selfId || this.peers.has(id)) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = {
      id,
      pc,
      dc: null,
      // Exactly one side of each pair is polite; it yields when offers collide.
      polite: this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
      verified: false,
      open: false,
      greeted: false,
      connState: "new",
      name: "Guest",
      state: { audio: false, video: false, camId: null, screenId: null },
      streams: new Map(),
      micSender: null,
      camSender: null,
      screenSender: null,
      sendSeq: 0,
      recvSeq: 0,
      inbox: Promise.resolve(),
      outbox: Promise.resolve(),
      timer: null,
    };
    this.peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal(peer, { description: pc.localDescription.toJSON() });
      } catch {
        /* the connection was closed mid-negotiation */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signal(peer, { candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      peer.connState = pc.connectionState;
      if (pc.connectionState === "failed") pc.restartIce();
      this.#update();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (!peer.streams.has(stream.id)) {
        peer.streams.set(stream.id, stream);
        stream.onremovetrack = () => {
          if (stream.getTracks().length === 0) peer.streams.delete(stream.id);
          this.#update();
        };
      }
      track.onunmute = () => this.#update();
      this.#refreshAnnotationSession();
      this.#update();
    };

    // Same pre-agreed channel on both sides, so neither has to wait for the other.
    const dc = pc.createDataChannel("app", { negotiated: true, id: 0 });
    peer.dc = dc;
    dc.onopen = () => {
      peer.open = true;
      this.#sendTo(peer, { t: "hello", name: this.name, state: this.#localState() });
      if (this.screenStream) {
        for (const [key, s] of this.strokes) {
          this.#sendTo(peer, { t: "anno", op: "stroke", key, color: s.color, size: s.size, pts: s.pts });
        }
      }
      this.#update();
    };
    dc.onclose = () => {
      peer.open = false;
      this.#update();
    };
    dc.onmessage = (ev) => this.#onData(peer, ev.data);

    this.#syncTracks(peer);

    // Someone who never proves they hold the code is dropped quietly.
    peer.timer = setTimeout(() => {
      if (!peer.verified) this.#removePeer(id);
    }, UNVERIFIED_TIMEOUT);
  }

  #removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    if (peer.dc) peer.dc.onmessage = peer.dc.onopen = peer.dc.onclose = null;
    peer.pc.close();
    if (peer.greeted && this.status === "joined") this.#toast(`${peer.name} left`);
    this.#refreshAnnotationSession();
    this.#update();
  }

  #closeAllPeers() {
    for (const id of [...this.peers.keys()]) this.#removePeer(id);
  }

  /* ------------------------------------------------------------ signaling */

  #context(from, to) {
    return `${this.#keys.roomId}|${from}|${to}`;
  }

  #signal(peer, payload) {
    const selfId = this.selfId;
    peer.outbox = peer.outbox
      .then(async () => {
        const data = await seal(
          this.#keys.signalKey,
          { n: ++peer.sendSeq, ...payload },
          this.#context(selfId, peer.id)
        );
        if (this.peers.get(peer.id) === peer) this.#socket.emit("signal", { to: peer.id, data });
      })
      .catch(() => {});
  }

  async #onSignal(peer, data) {
    if (this.peers.get(peer.id) !== peer) return;
    let msg;
    try {
      msg = await open(this.#keys.signalKey, data, this.#context(peer.id, this.selfId));
    } catch {
      return; // wrong key, tampered, or meant for someone else
    }
    if (!Number.isInteger(msg?.n) || msg.n <= peer.recvSeq) return; // replay
    peer.recvSeq = msg.n;
    if (!peer.verified) {
      peer.verified = true;
      this.#update();
    }

    const { pc } = peer;
    const { description, candidate } = msg;
    try {
      if (description) {
        if (description.type !== "offer" && description.type !== "answer") return;
        if (typeof description.sdp !== "string") return;
        const collision =
          description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.#signal(peer, { description: pc.localDescription.toJSON() });
        }
      } else if (candidate && typeof candidate === "object") {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn("Negotiation step failed:", err?.message || err);
    }
  }

  /* ---------------------------------------------------------------- media */

  #onMediaChange = () => {
    for (const peer of this.peers.values()) this.#syncTracks(peer);
    this.#broadcastState();
    this.#update();
  };

  /** Makes a peer connection's senders match the tracks we currently have. */
  #syncTracks(peer) {
    const { pc } = peer;
    if (pc.signalingState === "closed") return;
    const { audioTrack, videoTrack, stream } = this.media;

    if (peer.micSender) {
      if (peer.micSender.track !== audioTrack) peer.micSender.replaceTrack(audioTrack).catch(() => {});
    } else if (audioTrack) {
      peer.micSender = pc.addTrack(audioTrack, stream);
    }

    if (peer.camSender) {
      if (peer.camSender.track !== videoTrack) peer.camSender.replaceTrack(videoTrack).catch(() => {});
    } else if (videoTrack) {
      peer.camSender = pc.addTrack(videoTrack, stream);
    }

    const screenTrack = this.screenStream?.getVideoTracks()[0] || null;
    if (screenTrack && !peer.screenSender) {
      peer.screenSender = pc.addTrack(screenTrack, this.screenStream);
    } else if (!screenTrack && peer.screenSender) {
      pc.removeTrack(peer.screenSender);
      peer.screenSender = null;
    }
  }

  #localState() {
    return {
      audio: this.media.audioOn,
      video: this.media.videoOn,
      camId: this.media.stream.id,
      screenId: this.screenStream?.id || null,
    };
  }

  #broadcastState() {
    this.#broadcast({ t: "state", state: this.#localState() });
  }

  /** The current screen share: { id: "self" | peerId, name, stream } or null. */
  get sharer() {
    if (this.screenStream) return { id: "self", name: "You", stream: this.screenStream };
    for (const peer of this.visiblePeers) {
      const stream = peer.state.screenId && peer.streams.get(peer.state.screenId);
      if (stream) return { id: peer.id, name: peer.name, stream };
    }
    return null;
  }

  async startScreenShare() {
    if (this.screenStream || this.sharer) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
    } catch (err) {
      if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") {
        this.#toast("Screen sharing is not available in this browser.");
      }
      return;
    }
    if (this.status === "left") return stream.getTracks().forEach((t) => t.stop());
    const track = stream.getVideoTracks()[0];
    track.contentHint = "detail";
    // Fires when the user presses the browser's own "Stop sharing" button.
    track.addEventListener("ended", () => this.stopScreenShare());
    this.screenStream = stream;
    this.#afterScreenChange();
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.#stopScreenTracks();
    this.#afterScreenChange();
  }

  #stopScreenTracks() {
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
  }

  #afterScreenChange() {
    for (const peer of this.peers.values()) this.#syncTracks(peer);
    this.#broadcastState();
    this.#refreshAnnotationSession();
    this.#update();
  }

  /* --------------------------------------------------------- data channel */

  #sendTo(peer, msg) {
    if (peer.dc?.readyState !== "open") return;
    try {
      peer.dc.send(JSON.stringify(msg));
    } catch {
      /* channel closed between the check and the send */
    }
  }

  #broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.dc?.readyState !== "open") continue;
      try {
        peer.dc.send(text);
      } catch {
        /* ignore a channel that just closed */
      }
    }
  }

  #onData(peer, raw) {
    if (typeof raw !== "string" || raw.length > MAX_DC_MESSAGE) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.t) {
      case "hello":
        peer.name = cleanName(msg.name);
        this.#applyState(peer, msg.state);
        if (!peer.greeted) {
          peer.greeted = true;
          this.#toast(`${peer.name} joined`);
        }
        this.#update();
        break;
      case "state":
        this.#applyState(peer, msg.state);
        this.#update();
        break;
      case "chat":
        if (typeof msg.text !== "string") return;
        this.#addMessage({ from: peer.id, name: peer.name, text: msg.text.slice(0, MAX_CHAT), self: false });
        break;
      case "anno":
        this.#onAnnotation(peer, msg);
        break;
      default:
    }
  }

  #applyState(peer, state) {
    if (!state || typeof state !== "object") return;
    peer.state = {
      audio: !!state.audio,
      video: !!state.video,
      camId: typeof state.camId === "string" ? state.camId : null,
      screenId: typeof state.screenId === "string" ? state.screenId : null,
    };
    this.#refreshAnnotationSession();
  }

  /* ----------------------------------------------------------------- chat */

  sendChat(text) {
    const body = String(text).trim().slice(0, MAX_CHAT);
    if (!body) return;
    this.#broadcast({ t: "chat", text: body });
    this.#addMessage({ from: "self", name: this.name, text: body, self: true });
  }

  #addMessage(message) {
    // Timestamps are taken locally; a peer's clock is not trusted.
    const full = { id: crypto.randomUUID(), ts: Date.now(), ...message };
    this.messages = [...this.messages, full].slice(-MAX_MESSAGES);
    this.dispatchEvent(new CustomEvent("chat", { detail: full }));
    this.#update();
  }

  /* ----------------------------------------------------------- annotation */

  /** Strokes belong to one screen share; a new share starts with a clean sheet. */
  #refreshAnnotationSession() {
    const session = this.#annotationSession();
    if (session === this.#annoSession) return;
    this.#annoSession = session;
    if (this.strokes.size) {
      this.strokes.clear();
      this.#annoChanged();
    }
  }

  /**
   * Identifies the share from announced state rather than from the arrived
   * video track, because strokes can reach a late joiner before the picture.
   */
  #annotationSession() {
    if (this.screenStream) return `self:${this.screenStream.id}`;
    for (const peer of this.peers.values()) {
      if (peer.verified && peer.state.screenId) return `${peer.id}:${peer.state.screenId}`;
    }
    return null;
  }

  #annoChanged() {
    this.dispatchEvent(new Event("anno"));
  }

  /** Coordinates are fractions (0..1) of the shared picture, so every screen size agrees. */
  annoStart(color, size, x, y) {
    if (!this.sharer || this.strokes.size >= MAX_STROKES) return null;
    const id = String(++this.#strokeSeq);
    this.strokes.set(`${this.selfId}:${id}`, { owner: this.selfId, color, size, pts: [x, y] });
    this.#broadcast({ t: "anno", op: "start", id, color, size, x, y });
    this.#annoChanged();
    return id;
  }

  annoPoints(id, pts) {
    const stroke = this.strokes.get(`${this.selfId}:${id}`);
    if (!stroke || stroke.pts.length + pts.length > MAX_POINTS) return;
    stroke.pts.push(...pts);
    this.#broadcast({ t: "anno", op: "pts", id, pts });
    this.#annoChanged();
  }

  annoUndo() {
    const mine = [...this.strokes.entries()].filter(([, s]) => s.owner === this.selfId);
    const last = mine[mine.length - 1];
    if (!last) return;
    this.strokes.delete(last[0]);
    this.#broadcast({ t: "anno", op: "del", id: last[0].slice(this.selfId.length + 1) });
    this.#annoChanged();
  }

  annoClear() {
    if (!this.strokes.size) return;
    this.strokes.clear();
    this.#broadcast({ t: "anno", op: "clear" });
    this.#annoChanged();
  }

  #onAnnotation(peer, msg) {
    const session = this.#annotationSession();
    if (!session) return;
    const key = `${peer.id}:${msg.id}`;

    switch (msg.op) {
      case "start": {
        const x = unit(msg.x);
        const y = unit(msg.y);
        if (typeof msg.id !== "string" || msg.id.length > 16) return;
        if (x === null || y === null || !validBrush(msg) || this.strokes.size >= MAX_STROKES) return;
        this.strokes.set(key, { owner: peer.id, color: msg.color, size: msg.size, pts: [x, y] });
        break;
      }
      case "pts": {
        const stroke = this.strokes.get(key);
        const pts = cleanPoints(msg.pts);
        if (!stroke || !pts || stroke.pts.length + pts.length > MAX_POINTS) return;
        stroke.pts.push(...pts);
        break;
      }
      case "del":
        // The key is built from the sender's id, so peers can only remove their own strokes.
        if (!this.strokes.delete(key)) return;
        break;
      case "clear":
        this.strokes.clear();
        break;
      case "stroke": {
        // Full strokes are only accepted from the sharer, who brings late joiners up to date.
        if (!session.startsWith(`${peer.id}:`) || typeof msg.key !== "string" || msg.key.length > 64) return;
        const pts = cleanPoints(msg.pts);
        if (!pts || pts.length < 2 || pts.length > MAX_POINTS || !validBrush(msg)) return;
        if (this.strokes.size >= MAX_STROKES) return;
        const owner = msg.key.slice(0, msg.key.lastIndexOf(":"));
        this.strokes.set(msg.key, { owner, color: msg.color, size: msg.size, pts });
        break;
      }
      default:
        return;
    }
    this.#annoChanged();
  }

  /* ---------------------------------------------------------------- utils */

  #toast(text) {
    this.dispatchEvent(new CustomEvent("toast", { detail: text }));
  }

  #update() {
    this.dispatchEvent(new Event("update"));
  }
}

function validBrush(msg) {
  return (
    typeof msg.color === "string" &&
    COLOR_RE.test(msg.color) &&
    Number.isFinite(msg.size) &&
    msg.size >= 1 &&
    msg.size <= 40
  );
}

function cleanPoints(pts) {
  if (!Array.isArray(pts) || pts.length === 0 || pts.length % 2 !== 0 || pts.length > 2000) return null;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const v = unit(pts[i]);
    if (v === null) return null;
    out[i] = v;
  }
  return out;
}
