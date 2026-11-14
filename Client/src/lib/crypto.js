/**
 * Key handling for a call.
 *
 * The invite code is the only secret. It lives in the URL fragment, which
 * browsers never send to a server. Everything else is derived from it:
 *
 *   code --HKDF--> roomId      (public; tells the server which room to route to)
 *        --HKDF--> signal key  (AES-256-GCM; seals all signaling messages)
 *
 * Because the server cannot read or forge signaling, it cannot swap the DTLS
 * fingerprints inside the SDP, so the WebRTC media and data channels are
 * end-to-end encrypted between the people holding the code.
 */

// Crockford base32: no I, L, O or U, so codes survive being read aloud.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CODE_LENGTH = 20; // 20 symbols x 5 bits = 100 bits of entropy
const SALT = new TextEncoder().encode("video-chat-app/v2");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isCryptoAvailable() {
  return typeof window !== "undefined" && window.isSecureContext && !!window.crypto?.subtle;
}

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b & 31];
  return formatCode(raw);
}

function formatCode(raw) {
  return raw.match(/.{5}/g).join("-");
}

/**
 * Accepts a bare code or a full invite link and returns the canonical code,
 * or null when the input is not a valid code.
 */
export function parseCode(input) {
  if (typeof input !== "string") return null;
  let text = input.trim();
  const hash = text.lastIndexOf("#");
  if (hash !== -1) text = text.slice(hash + 1);
  const raw = text
    .toLowerCase()
    .replace(/o/g, "0")
    .replace(/[il]/g, "1")
    .replace(/[^0-9a-z]/g, "");
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return formatCode(raw);
}

export function inviteLink(code) {
  return `${window.location.origin}${window.location.pathname}#${code}`;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveRoomKeys(code) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(code), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("room-id") },
    material,
    128
  );
  const signalKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("signaling") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const roomId = [...new Uint8Array(idBits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { roomId, signalKey };
}

/**
 * Encrypts a JSON value. `context` is authenticated but not encrypted; binding
 * it to room, sender and recipient stops the server re-routing a message.
 */
export async function seal(key, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

/** Throws when the message was tampered with, re-routed, or sealed with another key. */
export async function open(key, sealed, context) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(sealed.iv), additionalData: encoder.encode(context) },
    key,
    fromBase64Url(sealed.ct)
  );
  return JSON.parse(decoder.decode(plain));
}
