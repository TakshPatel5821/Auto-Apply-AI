"use client";

import { useState } from "react";
import { ScanSearch, X, Loader2 } from "lucide-react";

interface AtsResult {
  score: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
}

// A standalone "paste JD + paste CV → ATS score" checker. Renders its own header
// button + modal; nothing is persisted.
export function AtsCheckerModal() {
  const [open, setOpen] = useState(false);
  const [jd, setJd] = useState("");
  const [cv, setCv] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AtsResult | null>(null);
  const [error, setError] = useState("");

  async function check() {
    if (!jd.trim() || !cv.trim()) {
      setError("Paste both the job description and your CV.");
      return;
    }
    setError("");
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/ats-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jd, cvText: cv }),
      });
      const data = await res.json();
      if (data.analysis) setResult(data.analysis);
      else setError(data.error || "Check failed.");
    } catch {
      setError("Check failed — see logs.");
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    setJd("");
    setCv("");
    setResult(null);
    setError("");
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 rounded-lg transition-colors"
        title="Check any résumé against any job description"
      >
        <ScanSearch className="w-3.5 h-3.5" />
        ATS Check
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm overflow-y-auto p-4">
          <div className="card-glass w-full max-w-3xl my-8 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScanSearch className="w-5 h-5 text-emerald-400" />
                <h3 className="text-base font-semibold text-white">ATS Checker</h3>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Paste a job description and your résumé/CV text → get a keyword-match ATS score with matched and missing keywords. Nothing is saved.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1.5">Job Description</label>
                <textarea
                  value={jd}
                  onChange={(e) => setJd(e.target.value)}
                  rows={11}
                  placeholder="Paste the full job posting…"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1.5">Your CV / Résumé (text)</label>
                <textarea
                  value={cv}
                  onChange={(e) => setCv(e.target.value)}
                  rows={11}
                  placeholder="Paste your résumé text…"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
                />
              </div>
            </div>

            {error && <div className="text-xs text-red-400">{error}</div>}

            <div className="flex items-center gap-2">
              <button
                onClick={check}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-br from-emerald-500/90 to-teal-600/90 hover:from-emerald-500 hover:to-teal-600 shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
                {loading ? "Checking…" : "Check ATS"}
              </button>
              {(jd || cv || result) && (
                <button onClick={clearAll} className="px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors">
                  Clear
                </button>
              )}
            </div>

            {result && <AtsResultView r={result} />}
          </div>
        </div>
      )}
    </>
  );
}

function AtsResultView({ r }: { r: AtsResult }) {
  const t = r.score >= 75 ? "text-green-400" : r.score >= 50 ? "text-yellow-400" : "text-red-400";
  const bar = r.score >= 75 ? "bg-green-500" : r.score >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="space-y-3 border-t border-white/[0.06] pt-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 uppercase tracking-wider">ATS Match</span>
        <div className="flex-1 h-2.5 bg-gray-800 rounded-full overflow-hidden max-w-sm">
          <div className={`h-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} />
        </div>
        <span className={`text-xl font-bold ${t}`}>{r.score}%</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Matched keywords ({r.matchedKeywords.length})</div>
          <div className="flex flex-wrap gap-1">
            {r.matchedKeywords.length ? (
              r.matchedKeywords.map((k) => (
                <span key={k} className="text-xs bg-green-900/40 text-green-300 px-2 py-0.5 rounded">{k}</span>
              ))
            ) : (
              <span className="text-xs text-gray-600">None</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Missing keywords ({r.missingKeywords.length})</div>
          <div className="flex flex-wrap gap-1">
            {r.missingKeywords.length ? (
              r.missingKeywords.map((k) => (
                <span key={k} className="text-xs bg-red-900/30 text-red-300 px-2 py-0.5 rounded">{k}</span>
              ))
            ) : (
              <span className="text-xs text-gray-600">None — great coverage</span>
            )}
          </div>
        </div>
      </div>
      {r.suggestions.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Suggestions</div>
          <ul className="space-y-1">
            {r.suggestions.map((s, i) => (
              <li key={i} className="text-xs text-gray-300 flex gap-2">
                <span className="text-emerald-400">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
