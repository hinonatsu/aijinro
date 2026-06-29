import crypto from "node:crypto";

export function id(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function token() {
  return crypto.randomBytes(24).toString("base64url");
}

export function sample(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

export function charLength(text) {
  return Array.from(String(text ?? "").trim()).length;
}

export function clampChars(text, limit = 60) {
  const chars = Array.from(String(text ?? "").trim());
  return chars.slice(0, limit).join("");
}

export function publicError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function toIso(value = Date.now()) {
  return new Date(value).toISOString();
}

export function stripControlChars(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}
