// ─── SSRF guard for user-supplied URLs ───────────────────────────────────────
// The "paste a job URL" flow lets an authenticated caller make the server fetch
// an arbitrary address. Without a guard that reaches anything the server can
// reach: localhost admin panels, Docker-network services (postgres, ollama), and
// cloud instance-metadata endpoints such as 169.254.169.254.
//
// We therefore require http(s), then resolve the hostname and reject any address
// that lands in a private, loopback, link-local or reserved range. Resolution
// closes the "public name that resolves to 127.0.0.1" hole; a determined DNS
// rebind could still race the later connect, which is acceptable for a
// single-user local tool but is why this is defence-in-depth, not a sandbox.

import { lookup } from "dns/promises";
import { isIP } from "net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

// Reserved IPv4 ranges that must never be fetched on a user's behalf.
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8    this network
  if (a === 10) return true; // 10.0.0.0/8   private
  if (a === 127) return true; // 127.0.0.0/8  loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip zone index
  if (addr === "::" || addr === "::1") return true; // unspecified / loopback
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local
  if (addr.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) — defer to the IPv4 rules.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true; // not an IP literal → caller should have resolved first
}

/**
 * Validate a user-supplied URL for server-side fetching. Resolves DNS, so this
 * is async and does one lookup per call.
 */
export async function assertSafeUrl(rawUrl: string): Promise<UrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `unsupported protocol "${parsed.protocol}" (use http or https)` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials in the URL are not allowed" };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1]
  if (!host) return { ok: false, reason: "missing hostname" };

  // An IP literal needs no lookup.
  if (isIP(host)) {
    return isBlockedAddress(host)
      ? { ok: false, reason: "refuses to fetch private or reserved addresses" }
      : { ok: true };
  }

  // "localhost" and friends never resolve publicly — reject before the lookup.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { ok: false, reason: "refuses to fetch internal hostnames" };
  }

  try {
    const records = await lookup(host, { all: true });
    if (!records.length) return { ok: false, reason: "hostname did not resolve" };
    if (records.some((r) => isBlockedAddress(r.address))) {
      return { ok: false, reason: "hostname resolves to a private or reserved address" };
    }
  } catch {
    return { ok: false, reason: "hostname did not resolve" };
  }

  return { ok: true };
}

/** Filter a list of URLs down to the safe ones, reporting what was rejected. */
export async function filterSafeUrls(
  urls: string[]
): Promise<{ safe: string[]; rejected: { url: string; reason: string }[] }> {
  const safe: string[] = [];
  const rejected: { url: string; reason: string }[] = [];
  const checks = await Promise.all(urls.map((u) => assertSafeUrl(u)));
  checks.forEach((check, i) => {
    if (check.ok) safe.push(urls[i]);
    else rejected.push({ url: urls[i], reason: check.reason || "rejected" });
  });
  return { safe, rejected };
}
