// ─── Local credential encryption (#22) ───────────────────────────────────────
// AES-256-GCM at rest, with a key stored in ~/.job-agent-tools/secret.key (chmod
// 600). This protects ATS/LinkedIn passwords and any sensitive stored answers so
// they aren't sitting in plaintext. It is LOCAL protection (key on the same
// machine) — not a substitute for a real secrets manager, but a real upgrade
// over plaintext `.env` for a single-user local install.

import crypto from "crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const KEY_DIR = join(homedir(), ".job-agent-tools");
const KEY_PATH = process.env.JOB_AGENT_KEY_PATH || join(KEY_DIR, "secret.key");
const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:"; // marks an encrypted blob so we can detect plaintext

let cachedKey: Buffer | null = null;

// Load the 32-byte key, generating + persisting one on first use.
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Allow an env-provided key (base64, 32 bytes) for ephemeral/CI environments.
  const envKey = process.env.JOB_AGENT_SECRET_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "base64");
    if (buf.length === 32) { cachedKey = buf; return buf; }
  }

  if (existsSync(KEY_PATH)) {
    const buf = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
    if (buf.length === 32) { cachedKey = buf; return buf; }
  }

  // Generate + persist a new key (best-effort lock-down of permissions).
  const key = crypto.randomBytes(32);
  try {
    if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
    writeFileSync(KEY_PATH, key.toString("base64"), { mode: 0o600 });
    try { chmodSync(KEY_PATH, 0o600); } catch { /* windows: ignore */ }
  } catch { /* if we can't persist, key lives only in memory this process */ }
  cachedKey = key;
  return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// Encrypt → "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>". Idempotent.
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

// Decrypt an "enc:v1:" blob. Plain (un-prefixed) input is returned as-is so the
// system keeps working during migration / for not-yet-encrypted values.
export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value; // tolerate plaintext
  try {
    const [, , ivB64, tagB64, ctB64] = value.split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return ""; // wrong key / corrupted → empty (caller falls back)
  }
}
