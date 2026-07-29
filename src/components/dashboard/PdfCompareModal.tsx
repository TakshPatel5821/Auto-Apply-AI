"use client";

import { useState } from "react";

interface PdfApp {
  id: string;
  job: { companyName: string; jobTitle: string };
  tailoredResume?: { pdfPath: string | null } | null;
  coverLetter?: { pdfPath: string | null } | null;
}

// Side-by-side PDF viewer: original (uploaded) résumé vs the job-tailored PDF,
// plus a tab to view the cover-letter PDF. Streams files from /api/applications/file.
export function PdfCompareModal({ app, onClose }: { app: PdfApp; onClose: () => void }) {
  const [tab, setTab] = useState<"resume" | "cover">("resume");
  // The API falls back to the job's latest doc when a relation isn't linked, so
  // we always offer both tabs and let the server resolve the actual file.
  const fileUrl = (type: string) => `/api/applications/file?id=${app.id}&type=${type}`;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card-glass w-full max-w-6xl h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-white/10 px-5 py-3 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white text-sm">
              Documents — {app.job.jobTitle} @ {app.job.companyName}
            </h2>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setTab("resume")}
                className={`text-xs px-3 py-1 rounded-lg ${tab === "resume" ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"}`}
              >
                Résumé (original vs tailored)
              </button>
              <button
                onClick={() => setTab("cover")}
                className={`text-xs px-3 py-1 rounded-lg ${tab === "cover" ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"}`}
              >
                Cover letter
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
        </div>

        {tab === "resume" ? (
          <div className="flex-1 grid grid-cols-2 gap-px bg-white/10 overflow-hidden">
            <div className="flex flex-col bg-gray-950">
              <div className="px-3 py-1.5 text-xs text-gray-400 flex items-center justify-between">
                <span>Original (uploaded)</span>
                <a href={fileUrl("original")} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open ↗</a>
              </div>
              <iframe src={fileUrl("original")} className="flex-1 w-full bg-white" title="Original résumé" />
            </div>
            <div className="flex flex-col bg-gray-950">
              <div className="px-3 py-1.5 text-xs text-gray-400 flex items-center justify-between">
                <span>Tailored for this job</span>
                <a href={fileUrl("resume")} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open ↗</a>
              </div>
              <iframe src={fileUrl("resume")} className="flex-1 w-full bg-white" title="Tailored résumé" />
            </div>
          </div>
        ) : (
          <div className="flex-1 bg-gray-950 flex flex-col">
            <div className="px-3 py-1.5 text-xs text-gray-400 flex items-center justify-between">
              <span>Cover letter</span>
              <a href={fileUrl("cover")} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open ↗</a>
            </div>
            <iframe src={fileUrl("cover")} className="flex-1 w-full bg-white" title="Cover letter" />
          </div>
        )}
      </div>
    </div>
  );
}
