import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Link2,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  ShieldCheck,
  Video,
  VideoOff,
} from "lucide-react";
import { inviteLink } from "../lib/crypto";
import { copyText, downloadChat, useEvent } from "../lib/util";
import VideoTile from "./VideoTile";
import ChatPanel from "./ChatPanel";
import ShareStage from "./ShareStage";
import Modal from "./Modal";

const ERRORS = {
  full: ["This call is full", "It already has the maximum number of people."],
  locked: ["This call is locked", "Someone inside has locked it. Ask them to unlock it, then try again."],
  rate: ["Too many attempts", "Wait a moment before trying again."],
  invalid: ["Could not join", "The invite is not valid."],
  unsupported: ["Browser not supported", "This browser is missing the encryption features the call needs."],
};

const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia;

export default function Call({ client, media, onLeave }) {
  useEvent(client, "update");
  useEvent(media, "change");

  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toasts, setToasts] = useState([]);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  const toast = useCallback((text) => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list.slice(-2), { id, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3500);
  }, []);

  useEffect(() => {
    const onToast = (e) => toast(e.detail);
    const onChat = (e) => {
      if (!e.detail.self && !chatOpenRef.current) setUnread((n) => n + 1);
    };
    client.addEventListener("toast", onToast);
    client.addEventListener("chat", onChat);
    return () => {
      client.removeEventListener("toast", onToast);
      client.removeEventListener("chat", onChat);
    };
  }, [client, toast]);

  // Surface device problems that appear mid-call (e.g. permission revoked).
  const deviceError = media.videoError || media.audioError;
  useEffect(() => {
    if (deviceError) toast(deviceError);
  }, [deviceError, toast]);

  const hasChat = client.messages.length > 0;

  // The chat only exists in this tab, so warn before a refresh or close throws it away.
  useEffect(() => {
    if (!hasChat) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasChat]);

  const toggleChat = useCallback(() => {
    setChatOpen((open) => !open);
    setUnread(0);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "m") media.setAudio(!media.audioOn);
      else if (key === "v") media.setVideo(!media.videoOn);
      else if (key === "c") toggleChat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media, toggleChat]);

  const copyInvite = async () => {
    if (await copyText(inviteLink(client.code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast("Could not copy. Copy the address from the address bar instead.");
    }
  };

  const requestLeave = () => (hasChat ? setConfirmLeave(true) : onLeave());

  if (client.status === "error") {
    const [title, body] = ERRORS[client.error] || ERRORS.invalid;
    return (
      <div className="center-page">
        <div className="card notice">
          <Lock size={28} />
          <h2>{title}</h2>
          <p>{body}</p>
          <button className="btn btn-primary" onClick={onLeave}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const peers = client.visiblePeers;
  const sharer = client.sharer;
  const sharingSelf = sharer?.id === "self";
  const alone = peers.length === 0;

  const tiles = (
    <>
      <VideoTile
        self
        stream={media.stream}
        name={client.name}
        label={`${client.name} (you)`}
        audioOn={media.audioOn}
        videoOn={media.videoOn}
      />
      {peers.map((p) => (
        <VideoTile
          key={p.id}
          stream={p.state.camId ? p.streams.get(p.state.camId) : null}
          name={p.name}
          audioOn={p.state.audio}
          videoOn={p.state.video}
          connecting={!p.open}
        />
      ))}
    </>
  );

  const banner =
    client.status === "joined"
      ? null
      : client.offline
      ? "Can't reach the server. Retrying…"
      : client.status === "reconnecting"
      ? "Connection lost. Reconnecting…"
      : "Connecting…";

  return (
    <div className={`call ${chatOpen ? "with-chat" : ""}`}>
      <header className="call-top">
        <div className="secure" title="Media and chat are encrypted between participants. The server cannot read them.">
          <ShieldCheck size={15} /> End-to-end encrypted
        </div>
        <div className="call-top-right">
          {client.locked && (
            <span className="tag">
              <Lock size={13} /> Locked
            </span>
          )}
          <span className="tag">
            {peers.length + 1} / {client.maxSize}
          </span>
        </div>
      </header>

      {banner && (
        <div className="banner" role="status">
          {banner}
        </div>
      )}

      <main className="call-main">
        {sharer ? (
          <div className="share-layout">
            <ShareStage key={sharer.stream.id} client={client} sharer={sharer} />
            <div className="strip">{tiles}</div>
          </div>
        ) : (
          <div className="grid" data-count={alone ? 2 : peers.length + 1}>
            {tiles}
            {alone && (
              <div className="invite-card">
                <h2>You&apos;re the only one here</h2>
                <p>Send the invite to the people you want in this call. Anyone with it can join.</p>
                <div className="invite-code mono">{client.code}</div>
                <button className="btn btn-primary" onClick={copyInvite}>
                  {copied ? <Check size={18} /> : <Link2 size={18} />}
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {chatOpen && <ChatPanel messages={client.messages} onSend={(t) => client.sendChat(t)} onClose={toggleChat} />}

      <footer className="controls" role="toolbar" aria-label="Call controls">
        <div className="controls-group">
          <ControlButton
            label={media.audioOn ? "Mute" : "Unmute"}
            off={!media.audioOn}
            onClick={() => media.setAudio(!media.audioOn)}
            icon={media.audioOn ? <Mic size={20} /> : <MicOff size={20} />}
          />
          <ControlButton
            label={media.videoOn ? "Stop video" : "Start video"}
            off={!media.videoOn}
            onClick={() => media.setVideo(!media.videoOn)}
            icon={media.videoOn ? <Video size={20} /> : <VideoOff size={20} />}
          />
          {canShareScreen && (
            <ControlButton
              label={sharingSelf ? "Stop sharing" : "Share screen"}
              active={sharingSelf}
              disabled={!!sharer && !sharingSelf}
              title={sharer && !sharingSelf ? `${sharer.name} is already sharing` : undefined}
              onClick={() => (sharingSelf ? client.stopScreenShare() : client.startScreenShare())}
              icon={sharingSelf ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
            />
          )}
        </div>

        <div className="controls-group">
          <ControlButton
            label="Chat"
            active={chatOpen}
            badge={unread}
            onClick={toggleChat}
            icon={<MessageSquare size={20} />}
          />
          <ControlButton
            label={copied ? "Copied" : "Invite"}
            onClick={copyInvite}
            icon={copied ? <Check size={20} /> : <Link2 size={20} />}
          />
          <ControlButton
            label={client.locked ? "Unlock" : "Lock"}
            active={client.locked}
            title={client.locked ? "Let new people join again" : "Stop anyone else from joining"}
            onClick={() => client.setLocked(!client.locked)}
            icon={client.locked ? <Lock size={20} /> : <LockOpen size={20} />}
          />
        </div>

        <button className="leave" onClick={requestLeave} aria-label="Leave call">
          <PhoneOff size={20} />
          <span>Leave</span>
        </button>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>

      {confirmLeave && (
        <Modal title="Save the chat before you go?" onClose={() => setConfirmLeave(false)}>
          <p>
            This call has {client.messages.length} chat message{client.messages.length === 1 ? "" : "s"}. They
            are not stored anywhere and will be gone once you leave.
          </p>
          <div className="modal-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                downloadChat(client.messages);
                onLeave();
              }}
            >
              Save and leave
            </button>
            <button className="btn btn-danger" onClick={onLeave}>
              Leave without saving
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirmLeave(false)}>
              Stay
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ControlButton({ label, icon, onClick, off, active, disabled, badge, title }) {
  return (
    <button
      className={`control ${off ? "off" : ""} ${active ? "active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <span className="control-icon">
        {icon}
        {badge > 0 && <span className="badge">{badge > 9 ? "9+" : badge}</span>}
      </span>
      <span className="control-label">{label}</span>
    </button>
  );
}
