# Hush — private video calls

Anonymous video calls for up to 4 people. No accounts, no database, nothing stored.

- Camera and microphone on/off, screen sharing, shared annotation on the shared screen
- In-call chat with download, and a "save the chat?" prompt when leaving
- Join by invite link or 20-character code
- Lock a call so nobody else can join

## Run

```bash
npm install
npm --prefix Client install
```

Development (two terminals):

```bash
npm run dev
npm run client
```

Open http://localhost:5173. If the server is not on port 3000, start the client with
`SIGNALING_URL=http://localhost:<port>`.

Production (one process serves the built client and the signaling):

```bash
npm run build
npm start
```

Camera, microphone and encryption need a secure context: `localhost` or **HTTPS**. Deploy behind TLS.
Settings are listed in `.env.example`.

## How the encryption works

The invite code (100 random bits) is the only secret. It sits in the URL fragment (`#code`), which
browsers never send to a server.

1. The browser derives two values from the code with HKDF-SHA-256: a public **room id** (what the
   server routes on) and an AES-256-GCM **signaling key**.
2. Every signaling message (SDP offers/answers, ICE candidates) is sealed with that key and bound to
   the room, sender, recipient and a sequence number. The server relays ciphertext; it cannot read,
   alter, re-route or replay it.
3. The sealed SDP carries each browser's DTLS certificate fingerprint. Because the server cannot
   forge it, the WebRTC DTLS-SRTP session is authenticated end to end. Audio, video, screen share,
   chat and annotations travel peer-to-peer inside that session (a TURN relay only sees ciphertext).
4. A participant is shown only after sending a correctly sealed message, i.e. proving they hold
   the code.

Server hardening: strict Content-Security-Policy and related headers (helmet), origin allow-list,
input validation, per-socket and per-IP rate limits, message size caps, room size cap, no logging of
payloads, rooms kept in memory only.

## Limits worth knowing

- **The link is the key.** Anyone who gets the invite can join until the call is locked. Share it
  over a channel you trust.
- **Peers see each other's IP address** — that is how peer-to-peer WebRTC works. The default STUN
  server (Google) also sees your IP. To hide IPs from peers, configure a TURN server and force relay.
- The server operator serves the app code. As with any web app, end-to-end encryption assumes the
  served JavaScript is honest.
- No TURN server is configured by default, so calls can fail on some corporate or mobile networks.
- A network drop reconnects you as a new participant; a locked call will not let you back in until
  someone unlocks it.
- Annotations are drawn on the in-app view of the shared screen, not on the sharer's actual desktop.
