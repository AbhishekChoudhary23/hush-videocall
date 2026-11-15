/**
 * Signaling server.
 *
 * The server is deliberately "blind": it only relays opaque, encrypted blobs
 * between members of a room. It never sees the invite code, display names,
 * SDP, ICE candidates, chat or media. Nothing is persisted; rooms live in
 * memory and vanish when the last member leaves.
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 4;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP ?? 30);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const ROOM_ID_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT = 64 * 1024;

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(
	helmet({
		contentSecurityPolicy: {
			useDefaults: false,
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				imgSrc: ["'self'", "data:", "blob:"],
				mediaSrc: ["'self'", "blob:"],
				fontSrc: ["'self'"],
				connectSrc: ["'self'", "ws:", "wss:"],
				workerSrc: ["'self'", "blob:"],
				objectSrc: ["'none'"],
				baseUri: ["'none'"],
				formAction: ["'none'"],
				frameAncestors: ["'none'"],
			},
		},
		referrerPolicy: { policy: "no-referrer" },
		crossOriginEmbedderPolicy: false,
	})
);
app.use((req, res, next) => {
	res.setHeader(
		"Permissions-Policy",
		"camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()"
	);
	next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

/*
 * ICE servers for the browsers. STUN alone fails when either side is behind
 * carrier-grade or symmetric NAT (most mobile data, many ISPs), so a TURN
 * relay is offered when one is configured. TURN only ever sees DTLS-SRTP
 * ciphertext. Provider API keys stay on the server; browsers receive
 * short-lived credentials.
 */
const DEFAULT_ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const ICE_TTL = 24 * 60 * 60; // seconds a credential stays valid
const ICE_CACHE_MS = 60 * 60 * 1000; // reuse a credential for at most 1 hour
let iceCache = { servers: null, expires: 0 };

// Browsers block port 53, and it only slows ICE gathering down.
const dropPort53 = (servers) =>
	servers.map((s) => ({
		...s,
		urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
	}));

async function fetchIceServers() {
	const { TURN_KEY_ID, TURN_KEY_API_TOKEN, METERED_DOMAIN, METERED_API_KEY, ICE_SERVERS } = process.env;
	if (TURN_KEY_ID && TURN_KEY_API_TOKEN) {
		const res = await fetch(
			`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ ttl: ICE_TTL }),
				signal: AbortSignal.timeout(5000),
			}
		);
		if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
		const body = await res.json();
		const servers = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
		return dropPort53(servers.filter(Boolean));
	}
	if (METERED_DOMAIN && METERED_API_KEY) {
		const res = await fetch(
			`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`,
			{ signal: AbortSignal.timeout(5000) }
		);
		if (!res.ok) throw new Error(`Metered TURN responded ${res.status}`);
		const servers = await res.json();
		if (!Array.isArray(servers)) throw new Error("Metered TURN returned an unexpected body");
		return dropPort53(servers);
	}
	if (ICE_SERVERS) {
		const servers = JSON.parse(ICE_SERVERS);
		if (Array.isArray(servers)) return servers;
	}
	return null;
}

const iceLimiter = new Map(); // ip -> { count, reset }
app.get("/api/ice", async (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	const ip = requestIp(req);
	const now = Date.now();
	const entry = iceLimiter.get(ip);
	if (entry && entry.reset > now && entry.count >= 30) return res.status(429).json({ iceServers: DEFAULT_ICE });
	if (!entry || entry.reset <= now) iceLimiter.set(ip, { count: 1, reset: now + 60_000 });
	else entry.count++;
	if (iceLimiter.size > 10_000) iceLimiter.clear();

	if (!iceCache.servers || iceCache.expires <= now) {
		try {
			const servers = await fetchIceServers();
			iceCache = { servers: servers || DEFAULT_ICE, expires: now + ICE_CACHE_MS };
		} catch (err) {
			console.error("Could not get TURN credentials:", err.message);
			// Retry soon rather than serving STUN-only for a whole hour.
			iceCache = { servers: DEFAULT_ICE, expires: now + 30_000 };
		}
	}
	res.json({ iceServers: iceCache.servers, relay: iceCache.servers !== DEFAULT_ICE });
});

// Serve the built client when it exists, so one process can host everything.
const distDir = path.join(__dirname, "Client", "dist");
if (fs.existsSync(path.join(distDir, "index.html"))) {
	app.use(express.static(distDir, { index: "index.html", maxAge: "1h" }));
	app.get("*", (req, res) => res.sendFile(path.join(distDir, "index.html")));
} else {
	app.get("/", (req, res) => res.send("Signaling server running"));
}

const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
	maxHttpBufferSize: 100 * 1024,
	serveClient: false,
});

/** roomId -> { members: Set<socketId>, locked: boolean } */
const rooms = new Map();
/** ip -> open connection count */
const connections = new Map();

function clientIp(socket) {
	return proxiedIp(socket.handshake.headers) || socket.handshake.address;
}

function requestIp(req) {
	return proxiedIp(req.headers) || req.socket.remoteAddress;
}

/**
 * Behind Render (which fronts services with Cloudflare) the last
 * X-Forwarded-For hop can be a shared proxy address, which would put many
 * visitors into one rate-limit bucket. Cloudflare sets CF-Connecting-IP
 * itself, so it is preferred when present.
 */
function proxiedIp(headers) {
	if (!TRUST_PROXY) return null;
	const cf = headers["cf-connecting-ip"] || headers["true-client-ip"];
	if (typeof cf === "string" && cf) return cf.trim();
	const xff = headers["x-forwarded-for"];
	if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
	return null;
}

/** Token bucket: bursts up to `capacity`, refills `perSecond` tokens each second. */
function createBucket(capacity, perSecond) {
	let tokens = capacity;
	let last = Date.now();
	return () => {
		const now = Date.now();
		tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSecond);
		last = now;
		if (tokens < 1) return false;
		tokens -= 1;
		return true;
	};
}

function isSealed(data) {
	return (
		data !== null &&
		typeof data === "object" &&
		typeof data.iv === "string" &&
		typeof data.ct === "string" &&
		data.iv.length === 16 &&
		data.ct.length > 0 &&
		data.ct.length <= MAX_CIPHERTEXT &&
		B64_RE.test(data.iv) &&
		B64_RE.test(data.ct)
	);
}

io.use((socket, next) => {
	if (!MAX_CONN_PER_IP) return next();
	const ip = clientIp(socket);
	const count = connections.get(ip) || 0;
	if (count >= MAX_CONN_PER_IP) return next(new Error("too many connections"));
	connections.set(ip, count + 1);
	socket.data.ip = ip;
	next();
});

io.on("connection", (socket) => {
	const allow = createBucket(200, 50);
	const allowJoin = createBucket(10, 0.2);
	let strikes = 0;

	// Drops the event when the socket is over budget; disconnects repeat offenders.
	const limited = (handler) => (...args) => {
		if (!allow()) {
			if (++strikes > 50) socket.disconnect(true);
			return;
		}
		try {
			handler(...args);
		} catch {
			/* malformed input from a client must never crash the server */
		}
	};

	const leaveRoom = () => {
		const roomId = socket.data.roomId;
		if (!roomId) return;
		socket.data.roomId = null;
		socket.leave(roomId);
		const room = rooms.get(roomId);
		if (!room) return;
		room.members.delete(socket.id);
		if (room.members.size === 0) rooms.delete(roomId);
		else socket.to(roomId).emit("peer-left", { id: socket.id });
	};

	socket.on(
		"join",
		limited((payload, ack) => {
			if (typeof ack !== "function") return;
			const roomId = payload && payload.roomId;
			if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId)) return ack({ ok: false, error: "invalid" });
			if (!allowJoin()) return ack({ ok: false, error: "rate" });
			if (socket.data.roomId) leaveRoom();

			let room = rooms.get(roomId);
			if (room && room.locked) return ack({ ok: false, error: "locked" });
			if (room && room.members.size >= MAX_ROOM_SIZE) return ack({ ok: false, error: "full" });
			if (!room) {
				room = { members: new Set(), locked: false };
				rooms.set(roomId, room);
			}

			const peers = [...room.members];
			room.members.add(socket.id);
			socket.data.roomId = roomId;
			socket.join(roomId);
			socket.to(roomId).emit("peer-joined", { id: socket.id });
			ack({ ok: true, id: socket.id, peers, locked: room.locked, max: MAX_ROOM_SIZE });
		})
	);

	socket.on(
		"signal",
		limited((payload) => {
			const roomId = socket.data.roomId;
			if (!roomId || !payload || typeof payload.to !== "string" || !isSealed(payload.data)) return;
			const room = rooms.get(roomId);
			// Only relay between members of the same room.
			if (!room || payload.to === socket.id || !room.members.has(payload.to)) return;
			io.to(payload.to).emit("signal", {
				from: socket.id,
				data: { iv: payload.data.iv, ct: payload.data.ct },
			});
		})
	);

	socket.on(
		"lock",
		limited((payload) => {
			const room = rooms.get(socket.data.roomId);
			if (!room || !payload || typeof payload.locked !== "boolean") return;
			room.locked = payload.locked;
			io.to(socket.data.roomId).emit("locked", { locked: room.locked });
		})
	);

	socket.on("leave", limited(leaveRoom));

	socket.on("disconnect", () => {
		leaveRoom();
		const ip = socket.data.ip;
		if (ip) {
			const count = (connections.get(ip) || 1) - 1;
			if (count <= 0) connections.delete(ip);
			else connections.set(ip, count);
		}
	});
});

server.listen(PORT, () => console.log(`Signaling server listening on port ${PORT}`));
