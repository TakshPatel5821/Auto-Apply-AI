"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { X, Loader2 } from "lucide-react";

// Monaco must load client-side only.
const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-gray-500 gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading diff editor…
      </div>
    ),
  }
);

interface DiffData {
  companyName: string;
  jobTitle: string;
  original: string;
  tailored: string;
  atsScore: number | null;
  keywordsAdded: string[];
  sectionsModified: string[];
  tailoringNotes: string | null;
  hasBaseline: boolean;
  coverLetter: string | null;
}

export function ResumeDiffModal({
  tailoredResumeId,
  onClose,
}: {
  tailoredResumeId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DiffData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"resume" | "cover">("resume");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/applications/diff?tailoredResumeId=${encodeURIComponent(tailoredResumeId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => !cancelled && setError("Failed to load diff"));
    return () => {
      cancelled = true;
    };
  }, [tailoredResumeId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card-glass w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-gray-800">
          <div>
            <h3 className="text-white font-semibold">
              Review before submitting{data ? ` — ${data.jobTitle} @ ${data.companyName}` : ""}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {view === "resume" ? "Left: base résumé · Right: tailored for this job" : "Cover letter to be submitted"}
            </p>
            {/* Tabs — both artifacts being submitted are reviewable here. */}
            <div className="mt-2 flex gap-1">
              <button
                onClick={() => setView("resume")}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                  view === "resume" ? "bg-purple-500/20 text-purple-200" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Résumé diff
              </button>
              <button
                onClick={() => setView("cover")}
                disabled={!data?.coverLetter}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  view === "cover" ? "bg-purple-500/20 text-purple-200" : "text-gray-500 hover:text-gray-300"
                }`}
                title={data?.coverLetter ? "" : "No cover letter generated for this job"}
              >
                Cover letter
              </button>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Metadata strip */}
        {data && (
          <div className="px-5 py-2.5 border-b border-gray-800 flex flex-wrap items-center gap-2 text-xs">
            {data.atsScore != null && (
              <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300">
                ATS {data.atsScore.toFixed(0)}/10
              </span>
            )}
            {data.keywordsAdded.slice(0, 12).map((kw) => (
              <span key={kw} className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-300">
                +{kw}
              </span>
            ))}
            {data.sectionsModified.length > 0 && (
              <span className="text-gray-500">
                modified: {data.sectionsModified.join(", ")}
              </span>
            )}
          </div>
        )}
        {data?.tailoringNotes && (
          <div className="px-5 py-2 border-b border-gray-800 text-xs text-gray-400 italic">
            {data.tailoringNotes}
          </div>
        )}

        {/* Diff body */}
        <div className="flex-1 min-h-0">
          {error ? (
            <div className="flex items-center justify-center h-full text-red-400">{error}</div>
          ) : !data ? (
            <div className="flex items-center justify-center h-full text-gray-500 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : view === "cover" ? (
            <div className="h-full overflow-auto px-6 py-4">
              <pre className="whitespace-pre-wrap font-sans text-sm text-gray-200 leading-relaxed">
                {data.coverLetter || "No cover letter was generated for this application."}
              </pre>
            </div>
          ) : !data.hasBaseline ? (
            <div className="flex items-center justify-center h-full text-gray-500 text-center px-8">
              No base résumé is stored to compare against yet. The baseline is captured the
              next time this résumé is tailored — re-run tailoring to enable the diff.
            </div>
          ) : (
            <DiffEditor
              height="100%"
              theme="vs-dark"
              language="plaintext"
              original={data.original}
              modified={data.tailored}
              options={{
                readOnly: true,
                renderSideBySide: true,
                wordWrap: "on",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 12,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
