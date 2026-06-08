"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Mail,
  Loader2,
  CheckCircle2,
  RefreshCw,
  KeyRound,
  Link2,
  Unlink,
  Copy,
} from "lucide-react";

interface Result {
  category: string;
  company: string | null;
  newStatus: string | null;
  summary: string;
  suggestedReply: string;
}

interface GmailStatus {
  connected: boolean;
  configured: boolean;
  address: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

interface EmailEvent {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  category: string | null;
  company: string | null;
  detectedStatus: string | null;
  isOtp: boolean;
  otpCode: string | null;
  statusApplied: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  INTERVIEW: "text-purple-400",
  ASSESSMENT: "text-yellow-400",
  OFFER: "text-pink-400",
  REJECTION: "text-red-400",
  RECRUITER: "text-blue-400",
  OTHER: "text-gray-400",
};

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // auto-scan every 2 min while panel is open

export function EmailClassifierPanel({ onApplied }: { onApplied?: () => void }) {
  const [open, setOpen] = useState(false);

  // Gmail connection + live inbox
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [events, setEvents] = useState<EmailEvent[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpResult, setOtpResult] = useState<{ code: string; from?: string } | null>(null);

  // Manual paste classifier (fallback)
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [updated, setUpdated] = useState<{ company: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/gmail/status").catch(() => null);
    if (res?.ok) setStatus(await res.json());
  }, []);

  const loadEvents = useCallback(async () => {
    const res = await fetch("/api/gmail/sync").catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      setEvents(data.events || []);
    }
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/gmail/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setSyncMsg(`Scanned ${data.scanned} new · ${data.updated?.length || 0} status update(s)`);
      if (data.updated?.length) onApplied?.();
      await loadEvents();
      await loadStatus();
    } catch (e) {
      setSyncMsg(String(e));
    } finally {
      setSyncing(false);
    }
  }, [loadEvents, loadStatus, onApplied]);

  // Initial load when the panel opens.
  useEffect(() => {
    if (!open) return;
    loadStatus();
    loadEvents();
  }, [open, loadStatus, loadEvents]);

  // Auto-scan on an interval while the panel is open + Gmail connected.
  useEffect(() => {
    if (!open || !status?.connected) return;
    const t = setInterval(() => runSync(), SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [open, status?.connected, runSync]);

  async function getOtp() {
    setOtpLoading(true);
    setOtpResult(null);
    try {
      const res = await fetch("/api/gmail/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sinceMinutes: 10 }),
      });
      const data = await res.json();
      if (res.ok && data.code) setOtpResult({ code: data.code, from: data.from });
      else setOtpResult({ code: "", from: data.error || "No code found" });
    } catch {
      setOtpResult({ code: "", from: "Failed to fetch" });
    } finally {
      setOtpLoading(false);
    }
  }

  async function disconnect() {
    await fetch("/api/gmail/disconnect", { method: "POST" }).catch(() => null);
    await loadStatus();
    setEvents([]);
  }

  async function classify(apply: boolean) {
    if (text.trim().length < 10) return;
    setLoading(true);
    setError(null);
    setUpdated(null);
    try {
      const res = await fetch("/api/applications/classify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailText: text, apply }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data.result);
      if (data.updated) {
        setUpdated({ company: data.updated.company, status: data.updated.status });
        onApplied?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card-glass">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-300 hover:text-white"
      >
        <Mail className="w-4 h-4 text-cyan-400" />
        Gmail inbox — auto-detect status (interview / offer / rejection) & verification codes
        {status?.connected && <span className="w-2 h-2 rounded-full bg-green-500" title="Gmail connected" />}
        <span className="ml-auto text-gray-600">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* ── Connection row ── */}
          <div className="flex items-center gap-2 flex-wrap bg-gray-800/40 border border-gray-700 rounded-lg p-2.5">
            {status?.connected ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-400" />
                <span className="text-sm text-gray-200">{status.address}</span>
                {status.lastSyncAt && (
                  <span className="text-xs text-gray-500">
                    · last scan {new Date(status.lastSyncAt).toLocaleTimeString()}
                  </span>
                )}
                <button
                  onClick={runSync}
                  disabled={syncing}
                  className="ml-auto px-2.5 py-1 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-xs rounded-lg flex items-center gap-1.5"
                >
                  {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Scan now
                </button>
                <button
                  onClick={getOtp}
                  disabled={otpLoading}
                  className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-xs rounded-lg flex items-center gap-1.5"
                >
                  {otpLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  Get latest code
                </button>
                <button
                  onClick={disconnect}
                  className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg flex items-center gap-1.5"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </>
            ) : status && !status.configured ? (
              <span className="text-xs text-amber-400">
                Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env to enable Gmail (see .env.example).
              </span>
            ) : (
              <>
                <span className="text-sm text-gray-400">Connect Gmail to auto-track status & fetch verification codes.</span>
                <a
                  href="/api/gmail/connect"
                  className="ml-auto px-2.5 py-1 bg-cyan-600 hover:bg-cyan-700 text-white text-xs rounded-lg flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Connect Gmail
                </a>
              </>
            )}
          </div>

          {syncMsg && <div className="text-xs text-gray-400">{syncMsg}</div>}

          {otpResult && (
            <div className="flex items-center gap-2 text-sm bg-gray-900/60 border border-gray-700 rounded-lg p-2.5">
              <KeyRound className="w-4 h-4 text-cyan-400" />
              {otpResult.code ? (
                <>
                  <span className="font-mono text-lg tracking-widest text-white">{otpResult.code}</span>
                  <span className="text-xs text-gray-500">from {otpResult.from}</span>
                  <button
                    onClick={() => navigator.clipboard?.writeText(otpResult.code)}
                    className="ml-auto px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                </>
              ) : (
                <span className="text-gray-400">{otpResult.from}</span>
              )}
            </div>
          )}

          {/* ── Live inbox list ── */}
          {status?.connected && events.length > 0 && (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className={`rounded-lg p-2.5 text-sm border ${
                    ev.isOtp ? "bg-cyan-950/30 border-cyan-800" : "bg-gray-800/40 border-gray-700"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {ev.isOtp ? (
                      <span className="flex items-center gap-1 text-cyan-300 font-mono tracking-widest">
                        <KeyRound className="w-3.5 h-3.5" />
                        {ev.otpCode}
                      </span>
                    ) : (
                      <span className={`text-xs font-semibold ${CATEGORY_COLORS[ev.category || "OTHER"]}`}>
                        {ev.category || "—"}
                      </span>
                    )}
                    {ev.company && <span className="text-xs text-gray-400">· {ev.company}</span>}
                    {ev.detectedStatus && (
                      <span className="text-xs text-gray-500">→ {ev.detectedStatus.replace(/_/g, " ")}</span>
                    )}
                    {ev.statusApplied && (
                      <span className="flex items-center gap-1 text-green-400 text-xs">
                        <CheckCircle2 className="w-3 h-3" /> applied
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-gray-600">
                      {new Date(ev.receivedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-gray-300 truncate mt-0.5">
                    {ev.subject || ev.snippet || "(no subject)"}
                  </div>
                  <div className="text-[11px] text-gray-600 truncate">{ev.fromName || ev.fromEmail}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Manual paste fallback ── */}
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-300 text-xs">
              Or paste an email manually
            </summary>
            <div className="mt-2 space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the full email here…"
                rows={5}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => classify(false)}
                  disabled={loading || text.trim().length < 10}
                  className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm rounded-lg flex items-center gap-2"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Classify"}
                </button>
                <button
                  onClick={() => classify(true)}
                  disabled={loading || text.trim().length < 10}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-sm rounded-lg"
                >
                  Classify & update status
                </button>
              </div>

              {error && <div className="text-red-400 text-sm">{error}</div>}

              {result && (
                <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold ${CATEGORY_COLORS[result.category] || "text-gray-400"}`}>
                      {result.category}
                    </span>
                    {result.company && <span className="text-gray-400">· {result.company}</span>}
                    {result.newStatus && (
                      <span className="text-xs text-gray-500">→ {result.newStatus.replace(/_/g, " ")}</span>
                    )}
                  </div>
                  <div className="text-gray-300">{result.summary}</div>
                  {updated && (
                    <div className="flex items-center gap-1.5 text-green-400 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Updated {updated.company} → {updated.status.replace(/_/g, " ")}
                    </div>
                  )}
                  {result.suggestedReply && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Suggested reply</div>
                      <div className="text-gray-200 whitespace-pre-wrap bg-gray-900/60 border border-gray-700 rounded p-2">
                        {result.suggestedReply}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
