"use client";

import { useEffect, useState } from "react";
import { X, Loader2, Copy, Check, Users } from "lucide-react";

interface Outreach {
  connectionNote: string;
  message: string;
  followUp: string;
}

interface Props {
  jobId: string;
  onClose: () => void;
}

export function RecruiterOutreachModal({ jobId, onClose }: Props) {
  const [recruiter, setRecruiter] = useState("");
  const [outreach, setOutreach] = useState<Outreach | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/recruiter-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, recruiterName: recruiter.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setOutreach(data.outreach);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Generate once on open.
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="card-glass max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-3 flex items-center justify-between">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" /> Recruiter Outreach
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-2">
            <input
              value={recruiter}
              onChange={(e) => setRecruiter(e.target.value)}
              placeholder="Recruiter name (optional)"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={generate}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Regenerate"}
            </button>
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          {loading && !outreach && (
            <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Drafting outreach…
            </div>
          )}

          {outreach && (
            <>
              <CopyBlock label="Connection request (under 300 chars)" text={outreach.connectionNote} />
              <CopyBlock label="Message / InMail" text={outreach.message} />
              <CopyBlock label="Follow-up (if no reply in ~1 week)" text={outreach.followUp} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500">{label}</span>
        <button onClick={copy} className="text-xs text-gray-400 hover:text-white flex items-center gap-1">
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="text-sm text-gray-200 bg-gray-800/60 border border-gray-700 rounded-lg p-3 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}
