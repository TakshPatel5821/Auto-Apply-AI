"use client";

import { useState } from "react";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";

interface Result {
  category: string;
  company: string | null;
  newStatus: string | null;
  summary: string;
  suggestedReply: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  INTERVIEW: "text-purple-400",
  ASSESSMENT: "text-yellow-400",
  OFFER: "text-pink-400",
  REJECTION: "text-red-400",
  RECRUITER: "text-blue-400",
  OTHER: "text-gray-400",
};

export function EmailClassifierPanel({ onApplied }: { onApplied?: () => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [updated, setUpdated] = useState<{ company: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        Paste an email to detect status (interview / offer / rejection)
        <span className="ml-auto text-gray-600">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
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
      )}
    </div>
  );
}
