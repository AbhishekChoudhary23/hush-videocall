import { useEffect, useReducer } from "react";

const ADJECTIVES = ["Quiet", "Amber", "Swift", "Mellow", "Bright", "Calm", "Lucky", "Nimble", "Gentle", "Bold", "Misty", "Sunny"];
const ANIMALS = ["Otter", "Heron", "Fox", "Lynx", "Finch", "Panda", "Koala", "Wren", "Seal", "Hare", "Owl", "Moth"];

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

export function randomName() {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

export function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

/** A stable hue per name, so each person keeps the same avatar colour. */
export function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Saves the chat as a plain text file. Nothing leaves the device. */
export function downloadChat(messages) {
  const now = new Date();
  const lines = [`Call chat - exported ${now.toLocaleString()}`, `${messages.length} message(s)`, ""];
  for (const m of messages) {
    lines.push(`[${formatTime(m.ts)}] ${m.name}${m.self ? " (you)" : ""}: ${m.text}`);
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `call-chat-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Re-renders the component whenever `target` dispatches `event`. */
export function useEvent(target, event = "update") {
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!target) return undefined;
    target.addEventListener(event, bump);
    return () => target.removeEventListener(event, bump);
  }, [target, event]);
}
