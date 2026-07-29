import { describe, it, expect } from "vitest";
import { assertSafeUrl, isBlockedAddress } from "@/lib/scraping/url-guard";

describe("isBlockedAddress", () => {
  it("blocks loopback, private and link-local IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.169.254", // cloud instance metadata
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "13.107.42.14"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks loopback, unique-local and link-local IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("treats a non-IP string as blocked (caller must resolve first)", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-http(s) protocols", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com", "gopher://example.com"]) {
      const res = await assertSafeUrl(url);
      expect(res.ok, url).toBe(false);
    }
  });

  it("rejects loopback and metadata addresses by literal IP", async () => {
    for (const url of [
      "http://127.0.0.1:3000/api/settings",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:5432/",
      "http://192.168.1.1/admin",
    ]) {
      const res = await assertSafeUrl(url);
      expect(res.ok, url).toBe(false);
    }
  });

  it("rejects internal hostnames without a DNS lookup", async () => {
    for (const url of [
      "http://localhost:3000/",
      "http://postgres.internal/",
      "http://printer.local/",
    ]) {
      const res = await assertSafeUrl(url);
      expect(res.ok, url).toBe(false);
    }
  });

  it("rejects URLs carrying credentials", async () => {
    const res = await assertSafeUrl("http://user:pass@boards.greenhouse.io/acme");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/credentials/);
  });

  it("rejects malformed input", async () => {
    expect((await assertSafeUrl("not a url")).ok).toBe(false);
    expect((await assertSafeUrl("")).ok).toBe(false);
  });
});
