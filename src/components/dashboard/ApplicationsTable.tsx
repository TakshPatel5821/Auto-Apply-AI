"use client";

import { useState, useEffect } from "react";
import { ExternalLink, FileText, FileIcon, Send, Zap, AlertCircle, RefreshCw, GitCompare, GraduationCap, Users, History, Files, RotateCw, Trash2 } from "lucide-react";
import { ResumeDiffModal } from "./ResumeDiffModal";
import { InterviewPrepModal } from "./InterviewPrepModal";
import { RecruiterOutreachModal } from "./RecruiterOutreachModal";
import { PdfCompareModal } from "./PdfCompareModal";

const STATUS_OPTIONS = [
  "SUBMITTED",
  "CONFIRMED",
  "INTERVIEW_SCHEDULED",
  "OFFER_RECEIVED",
  "REJECTED",
  "WITHDRAWN",
];

interface ActionLogEntry { t: string; action: string; target?: string; detail?: string }
interface Application {
  id: string;
  status: string;
  appliedAt: string | null;
  updatedAt: string;
  error?: string | null;
  retryCount?: number;
  recoveryState?: { url?: string; phase?: string; ts?: string } | null;
  actionLog?: ActionLogEntry[];
  job: {
    id: string;
    companyName: string;
    jobTitle: string;
    location: string | null;
    platform: string;
    matchScore: number | null;
    url: string;
    applyUrl: string | null;
    isEasyApply: boolean;
  };
  tailoredResume: { id: string; atsScore: number | null; pdfPath: string | null } | null;
  coverLetter: { id: string; pdfPath: string | null } | null;
}

const statusColors: Record<string, string> = {
  PENDING: "bg-gray-700 text-gray-300",
  APPROVED: "bg-blue-900 text-blue-300",
  IN_PROGRESS: "bg-yellow-900 text-yellow-300 animate-pulse",
  SUBMITTED: "bg-purple-900 text-purple-300",
  CONFIRMED: "bg-green-900 text-green-300",
  FAILED: "bg-red-900 text-red-300",
  REJECTED: "bg-red-900 text-red-400",
  INTERVIEW_SCHEDULED: "bg-emerald-900 text-emerald-300",
  OFFER_RECEIVED: "bg-cyan-900 text-cyan-300",
};

export function ApplicationsTable({
  applications,
  onRefresh,
}: {
  applications: Application[];
  onRefresh: () => void;
}) {
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);
  const [prepJobId, setPrepJobId] = useState<string | null>(null);
  const [outreachJobId, setOutreachJobId] = useState<string | null>(null);
  const [logApp, setLogApp] = useState<Application | null>(null);
  const [pdfApp, setPdfApp] = useState<Application | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function regenerate(app: Application) {
    setBusy(app.id, true);
    setMessage(`Regenerating résumé + cover letter for ${app.job.companyName}…`);
    const res = await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tailor", jobId: app.job.id }),
    });
    const data = await res.json().catch(() => ({}));
    setMessage(res.ok ? `Regenerated for ${app.job.companyName}` : data.error || "Regenerate failed");
    setTimeout(() => setMessage(null), 5000);
    setBusy(app.id, false);
    onRefresh();
  }

  async function regenerateSelected() {
    const apps = applications.filter((a) => selected.has(a.id));
    if (apps.length === 0) return;
    setBulkRunning(true);
    setMessage(`Regenerating ${apps.length} selected…`);
    let ok = 0;
    for (const app of apps) {
      const res = await fetch("/api/applications/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tailor", jobId: app.job.id }),
      });
      if (res.ok) ok++;
    }
    setBulkRunning(false);
    setSelected(new Set());
    setMessage(`Regenerated ${ok}/${apps.length} selected`);
    setTimeout(() => setMessage(null), 6000);
    onRefresh();
  }

  async function deleteApp(app: Application) {
    if (!confirm(`Delete "${app.job.companyName} — ${app.job.jobTitle}"?\n\nThis removes the company/job and its application, tailored résumé, and cover letter. This cannot be undone.`)) {
      return;
    }
    setBusy(app.id, true);
    const res = await fetch("/api/applications/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: app.id, deleteJob: true }),
    });
    setBusy(app.id, false);
    if (res.ok) {
      setSelected((prev) => { const n = new Set(prev); n.delete(app.id); return n; });
      onRefresh();
    } else {
      const d = await res.json().catch(() => ({}));
      setMessage(d.error || "Delete failed");
      setTimeout(() => setMessage(null), 5000);
    }
  }

  async function updateStatus(applicationId: string, status: string) {
    await fetch("/api/applications/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId, status }),
    });
    onRefresh();
  }

  function setBusy(id: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function approve(appId: string) {
    setBusy(appId, true);
    await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: appId, action: "approve" }),
    });
    setBusy(appId, false);
    onRefresh();
  }

  async function submit(appId: string) {
    setBusy(appId, true);
    const res = await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationId: appId, action: "submit" }),
    });
    const data = await res.json();
    setMessage(data.message || (data.success ? "Application submission started" : data.error || "Submit failed"));
    setTimeout(() => setMessage(null), 5000);
    setBusy(appId, false);
    onRefresh();
  }

  async function applyAll() {
    setBulkRunning(true);
    setMessage(null);
    const res = await fetch("/api/applications/apply-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 20 }),
    });
    const data = await res.json();
    setMessage(data.message);
    setTimeout(() => setMessage(null), 6000);
    setBulkRunning(false);
    onRefresh();
  }

  const readyCount = applications.filter((a) => a.status === "APPROVED" || a.status === "PENDING").length;

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {applications.length > 0 && (
        <div className="card-glass p-3 flex items-center gap-3">
          <div className="flex-1 flex items-center gap-2">
            <Send className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-gray-300">
              <span className="font-semibold text-white">{readyCount}</span> application{readyCount === 1 ? "" : "s"} ready to submit
            </span>
          </div>
          {selected.size > 0 && (
            <button
              onClick={regenerateSelected}
              disabled={bulkRunning}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              title="Re-tailor résumé + cover letter for the selected applications"
            >
              {bulkRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
              Regenerate selected ({selected.size})
            </button>
          )}
          <button
            onClick={applyAll}
            disabled={bulkRunning || readyCount === 0}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {bulkRunning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Apply to All Ready
              </>
            )}
          </button>
          <button
            onClick={onRefresh}
            className="p-2 text-gray-500 hover:text-gray-300 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Toast message */}
      {message && (
        <div className="bg-blue-900/30 border border-blue-800 text-blue-300 text-sm px-4 py-2 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {message}
        </div>
      )}

      <div className="overflow-x-auto card-glass">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              <th className="px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={applications.length > 0 && selected.size === applications.length}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(applications.map((a) => a.id)) : new Set())
                  }
                />
              </th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Company</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Role</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Status</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Match</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Applied</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Files</th>
              <th className="text-right px-4 py-3 text-gray-400 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((app) => {
              const busy = busyIds.has(app.id);
              return (
                <tr key={app.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${app.job.companyName}`}
                      checked={selected.has(app.id)}
                      onChange={() => toggleSelect(app.id)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{app.job.companyName}</div>
                    <div className="text-xs text-gray-500 capitalize flex items-center gap-1">
                      {app.job.platform}
                      {app.job.isEasyApply && (
                        <span className="text-blue-400 text-[10px] uppercase">• Easy Apply</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300">{app.job.jobTitle}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[app.status] || "bg-gray-700 text-gray-400"}`}>
                        {app.status}
                      </span>
                      <select
                        value=""
                        onChange={(e) => e.target.value && updateStatus(app.id, e.target.value)}
                        className="bg-gray-800 border border-gray-700 rounded text-[10px] text-gray-400 px-1 py-0.5 focus:outline-none"
                        title="Update status"
                      >
                        <option value="">↻</option>
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                    </div>
                    {app.error && (
                      <div className="text-[10px] text-red-400 mt-1 max-w-[200px] truncate" title={app.error}>
                        {app.error}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-bold text-white">
                      {app.job.matchScore?.toFixed(1) || "—"}
                    </span>
                    {app.tailoredResume?.atsScore && (
                      <div className="text-xs text-gray-500">ATS:{app.tailoredResume.atsScore.toFixed(0)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {app.appliedAt ? new Date(app.appliedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {/* Open the tailored résumé PDF directly in a new tab */}
                      <a
                        href={`/api/applications/file?id=${app.id}&type=resume`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open résumé PDF"
                        className="text-purple-400 hover:text-purple-300"
                      >
                        <FileText className="w-4 h-4" />
                      </a>
                      {/* Open the cover-letter PDF directly in a new tab */}
                      <a
                        href={`/api/applications/file?id=${app.id}&type=cover`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open cover letter PDF"
                        className="text-blue-400 hover:text-blue-300"
                      >
                        <FileIcon className="w-4 h-4" />
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={app.job.applyUrl || app.job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                        title="Open job posting"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>

                      {/* Résumé diff (base vs tailored, LaTeX) */}
                      {app.tailoredResume && (
                        <button
                          onClick={() => setDiffId(app.tailoredResume!.id)}
                          className="p-1.5 text-gray-500 hover:text-purple-400 transition-colors"
                          title="View résumé diff (base vs tailored, source)"
                        >
                          <GitCompare className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Compare PDFs (original vs tailored) + view cover letter */}
                      <button
                        onClick={() => setPdfApp(app)}
                        className="p-1.5 text-gray-500 hover:text-purple-400 transition-colors"
                        title="Compare PDFs (original vs tailored) + view cover letter"
                      >
                        <Files className="w-3.5 h-3.5" />
                      </button>

                      {/* Regenerate résumé + cover letter for this job */}
                      <button
                        onClick={() => regenerate(app)}
                        disabled={busy}
                        className="p-1.5 text-gray-500 hover:text-amber-400 disabled:opacity-40 transition-colors"
                        title="Regenerate résumé + cover letter for this job"
                      >
                        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
                      </button>

                      {/* Delete this company/job */}
                      <button
                        onClick={() => deleteApp(app)}
                        disabled={busy}
                        className="p-1.5 text-gray-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                        title="Delete this company/job"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>

                      {/* Action log / recovery */}
                      {(app.actionLog?.length || app.recoveryState) && (
                        <button
                          onClick={() => setLogApp(app)}
                          className="p-1.5 text-gray-500 hover:text-amber-400 transition-colors"
                          title="View action log / where it stopped"
                        >
                          <History className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Recruiter outreach */}
                      <button
                        onClick={() => setOutreachJobId(app.job.id)}
                        className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                        title="Recruiter outreach"
                      >
                        <Users className="w-3.5 h-3.5" />
                      </button>

                      {/* AI interview prep */}
                      <button
                        onClick={() => setPrepJobId(app.job.id)}
                        className="p-1.5 text-gray-500 hover:text-emerald-400 transition-colors"
                        title="AI interview prep"
                      >
                        <GraduationCap className="w-3.5 h-3.5" />
                      </button>

                      {/* PENDING → show Approve + Apply Now */}
                      {app.status === "PENDING" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => approve(app.id)}
                            className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
                          >
                            Approve
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => submit(app.id)}
                            className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1"
                            title="Approve and apply in one click"
                          >
                            <Zap className="w-3 h-3" />
                            Apply Now
                          </button>
                        </>
                      )}

                      {/* APPROVED → show Apply */}
                      {app.status === "APPROVED" && (
                        <button
                          disabled={busy}
                          onClick={() => submit(app.id)}
                          className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1"
                        >
                          {busy ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              ...
                            </>
                          ) : (
                            <>
                              <Send className="w-3 h-3" />
                              Apply
                            </>
                          )}
                        </button>
                      )}

                      {/* FAILED → Retry */}
                      {app.status === "FAILED" && (
                        <button
                          disabled={busy}
                          onClick={() => submit(app.id)}
                          className="text-xs px-2 py-1 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {applications.length === 0 && (
          <div className="text-center py-12 text-gray-600">
            No applications yet. Run the automation to scrape + tailor + apply.
          </div>
        )}
      </div>

      {diffId && <ResumeDiffModal tailoredResumeId={diffId} onClose={() => setDiffId(null)} />}
      {prepJobId && <InterviewPrepModal jobId={prepJobId} onClose={() => setPrepJobId(null)} />}
      {outreachJobId && <RecruiterOutreachModal jobId={outreachJobId} onClose={() => setOutreachJobId(null)} />}
      {logApp && <ActionLogModal app={logApp} onClose={() => setLogApp(null)} />}
      {pdfApp && <PdfCompareModal app={pdfApp} onClose={() => setPdfApp(null)} />}
    </div>
  );
}

interface FieldDecision {
  step: number;
  label: string;
  category: string;
  domKind: string;
  source: string | null;
  confidence: number | null;
  decision: string;
  valuePreview: string | null;
  reason: string | null;
}

const DECISION_COLORS: Record<string, string> = {
  filled: "bg-green-900/40 text-green-300",
  verified: "bg-green-900/40 text-green-300",
  consent: "bg-emerald-900/40 text-emerald-300",
  prefilled: "bg-sky-900/40 text-sky-300",
  pause: "bg-amber-900/40 text-amber-300",
  reject: "bg-red-900/40 text-red-300",
};

function ActionLogModal({ app, onClose }: { app: Application; onClose: () => void }) {
  const log = app.actionLog || [];
  const rec = app.recoveryState;
  const [tab, setTab] = useState<"decisions" | "actions">("decisions");
  const [decisions, setDecisions] = useState<FieldDecision[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/applications/decisions?id=${app.id}`)
      .then((r) => (r.ok ? r.json() : { fieldDecisions: [] }))
      .then((d) => { if (alive) setDecisions(d.fieldDecisions || []); })
      .catch(() => { if (alive) setDecisions([]); });
    return () => { alive = false; };
  }, [app.id]);

  // Group decisions by fill-pass step.
  const bySteps = (decisions || []).reduce<Record<number, FieldDecision[]>>((acc, d) => {
    (acc[d.step] ??= []).push(d);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card-glass max-w-2xl w-full max-h-[82vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-gray-900/90 backdrop-blur border-b border-white/10 px-5 py-3 flex items-center justify-between">
          <h2 className="font-semibold text-white text-sm">Run details — {app.job.companyName}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
        </div>

        <div className="px-5 pt-3 flex gap-2">
          <button
            onClick={() => setTab("decisions")}
            className={`text-xs px-3 py-1 rounded-lg ${tab === "decisions" ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"}`}
          >
            Field decisions {decisions ? `(${decisions.length})` : ""}
          </button>
          <button
            onClick={() => setTab("actions")}
            className={`text-xs px-3 py-1 rounded-lg ${tab === "actions" ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200"}`}
          >
            Action log ({log.length})
          </button>
        </div>

        <div className="p-5 space-y-3">
          {rec?.phase && (
            <div className="text-xs text-amber-400">
              Last checkpoint: <span className="font-medium">{rec.phase}</span>
              {rec.url ? <> · <span className="text-gray-500 break-all">{rec.url}</span></> : null}
            </div>
          )}
          {app.error && <div className="text-xs text-red-400 break-words">Error: {app.error}</div>}

          {tab === "decisions" && (
            <div className="space-y-3">
              {decisions === null && <div className="text-xs text-gray-600">Loading field decisions…</div>}
              {decisions !== null && decisions.length === 0 && (
                <div className="text-xs text-gray-600">No field decisions recorded for this run.</div>
              )}
              {Object.entries(bySteps).map(([step, items]) => (
                <div key={step}>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Step {step}</div>
                  <div className="space-y-1">
                    {items.map((d, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${DECISION_COLORS[d.decision] || "bg-gray-700 text-gray-300"}`}>
                          {d.decision}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-200 truncate" title={d.label}>{d.label}</div>
                          <div className="text-gray-500">
                            {d.category}/{d.domKind}
                            {d.source ? ` · ${d.source}` : ""}
                            {d.confidence != null ? ` · ${Math.round(d.confidence * 100)}%` : ""}
                            {d.valuePreview ? ` · “${d.valuePreview}”` : ""}
                            {d.reason ? ` · ${d.reason}` : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "actions" && (
            <div className="space-y-1">
              {log.length === 0 && <div className="text-xs text-gray-600">No actions recorded.</div>}
              {log.map((a, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="text-gray-600 tabular-nums w-16 flex-shrink-0">{a.t?.slice(11, 19)}</span>
                  <span className="text-gray-300 w-28 flex-shrink-0">{a.action}</span>
                  <span className="text-gray-500 break-all">{[a.target, a.detail].filter(Boolean).join(" — ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
