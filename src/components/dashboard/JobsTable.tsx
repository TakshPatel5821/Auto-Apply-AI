"use client";

import { useState, Fragment } from "react";
import { ExternalLink, Wand2, Send, ChevronDown, ChevronUp, Gauge, Loader2, ShieldCheck } from "lucide-react";
import { ScreeningPanel, type ScreeningView } from "./ScreeningPanel";

interface AtsAnalysis {
  score: number;
  fit: { technical: number; experience: number; education: number; overall: number };
  strongMatches: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
}

interface Job {
  id: string;
  companyName: string;
  jobTitle: string;
  location: string | null;
  platform: string;
  matchScore: number | null;
  atsScore: number | null;
  atsKeywordScore: number | null;
  sponsorshipStatus: string | null;
  intlFriendlyScore: number | null;
  salary: string | null;
  isRemote: boolean;
  isEasyApply: boolean;
  status: string;
  requiredSkills: string[];
  missingSkills: string[];
  applyUrl: string | null;
  url: string;
  scrapedAt: string;
  application: { status: string; appliedAt: string | null } | null;
  _count?: { tailoredResumes: number };
}

// Job statuses we should NOT bulk-tailor (already applied / terminal / skipped).
// Kept in sync with the /api/applications/tailor-all route.
const SKIP_STATUSES = ["APPLYING", "APPLIED", "INTERVIEWING", "OFFERED", "REJECTED", "WITHDRAWN", "SKIPPED"];

function ScoreBadge({ score }: { score: number | null }) {
  if (!score) return <span className="text-gray-600 text-xs">—</span>;
  const pct = Math.round((1 - (score - 1) / 9) * 100);
  const color =
    pct >= 80 ? "text-green-400" : pct >= 60 ? "text-yellow-400" : "text-red-400";
  return <span className={`text-sm font-bold ${color}`}>{score.toFixed(1)}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    FOUND: "bg-gray-700 text-gray-300",
    ANALYZED: "bg-blue-900 text-blue-300",
    TAILORED: "bg-purple-900 text-purple-300",
    APPLYING: "bg-yellow-900 text-yellow-300",
    APPLIED: "bg-green-900 text-green-300",
    FAILED: "bg-red-900 text-red-300",
    SKIPPED: "bg-gray-800 text-gray-500",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] || "bg-gray-700 text-gray-400"}`}>
      {status}
    </span>
  );
}

export function JobsTable({
  jobs,
  onRefresh,
}: {
  jobs: Job[];
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sortField, setSortField] = useState<"matchScore" | "scrapedAt">("matchScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState<string | null>(null);
  // ATS analysis results + the row currently expanded.
  const [atsResults, setAtsResults] = useState<Record<string, AtsAnalysis>>({});
  const [atsOpen, setAtsOpen] = useState<string | null>(null);
  // Employer-ATS screening results + the row currently expanded.
  const [screenResults, setScreenResults] = useState<Record<string, ScreeningView>>({});
  const [screenOpen, setScreenOpen] = useState<string | null>(null);
  // Bulk "Tailor All" run state + the latest status message.
  const [bulkTailoring, setBulkTailoring] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  // Jobs that still need analyze + cover letter + résumé (no tailored résumé yet).
  const needsTailoring = jobs.filter(
    (j) => (j._count?.tailoredResumes ?? 0) === 0 && !SKIP_STATUSES.includes(j.status)
  );

  const filtered = jobs
    .filter((j) => {
      if (statusFilter !== "ALL" && j.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return j.companyName.toLowerCase().includes(q) || j.jobTitle.toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const av = (a[sortField] as number | string | null) ?? (sortField === "matchScore" ? 99 : "");
      const bv = (b[sortField] as number | string | null) ?? (sortField === "matchScore" ? 99 : "");
      return sortDir === "asc" ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
    });

  function toggleSort(field: typeof sortField) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  }

  // Kick off the bulk tailor (analyze + cover letter + résumé for every untailored
  // job), then poll the server until the run finishes, refreshing the table as
  // applications appear. Prepares only — submitting stays with the Apply flow.
  async function tailorAll() {
    setBulkTailoring(true);
    setBulkMsg(null);
    try {
      const res = await fetch("/api/applications/tailor-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setBulkMsg(data.message || null);
      if (!data.success) {
        setBulkTailoring(false);
        return;
      }
      const poll = setInterval(async () => {
        onRefresh();
        const s = await fetch("/api/applications/tailor-all")
          .then((r) => r.json())
          .catch(() => ({ running: false }));
        if (!s.running) {
          clearInterval(poll);
          setBulkTailoring(false);
          setBulkMsg("Done — résumés and cover letters are ready. Review and apply below.");
          onRefresh();
        }
      }, 5000);
    } catch {
      setBulkTailoring(false);
      setBulkMsg("Couldn't start bulk tailor — check the logs.");
    }
  }

  async function tailorResume(jobId: string) {
    setLoading(jobId + "_tailor");
    await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action: "tailor" }),
    });
    setLoading(null);
    onRefresh();
  }

  async function applyNow(jobId: string) {
    setLoading(jobId + "_apply");
    await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action: "submit" }),
    });
    setLoading(null);
    onRefresh();
  }

  async function analyzeAts(jobId: string) {
    // Toggle closed if already showing this row.
    if (atsOpen === jobId) { setAtsOpen(null); return; }
    if (atsResults[jobId]) { setAtsOpen(jobId); return; }

    setLoading(jobId + "_ats");
    try {
      const res = await fetch("/api/jobs/ats-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.analysis) {
        setAtsResults((prev) => ({ ...prev, [jobId]: data.analysis }));
        setAtsOpen(jobId);
      }
    } finally {
      setLoading(null);
    }
  }

  // Run the employer-side ATS screening loop for a job (accept/reject + round
  // history + gaps), then show it inline. Toggles closed if already open.
  async function screenJob(jobId: string) {
    if (screenOpen === jobId) { setScreenOpen(null); return; }
    if (screenResults[jobId]) { setScreenOpen(jobId); return; }
    setLoading(jobId + "_screen");
    try {
      const res = await fetch("/api/applications/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.screening) {
        setScreenResults((prev) => ({ ...prev, [jobId]: data.screening }));
        setScreenOpen(jobId);
      }
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-40 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none"
        >
          <option value="ALL">All Status</option>
          {["FOUND", "ANALYZED", "TAILORED", "APPLIED", "FAILED", "SKIPPED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={tailorAll}
          disabled={bulkTailoring || needsTailoring.length === 0}
          title="Analyze each job and generate a tailored résumé + cover letter for every job that doesn't have one yet"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-br from-violet-500/90 to-fuchsia-600/90 hover:from-violet-500 hover:to-fuchsia-600 shadow-lg shadow-violet-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {bulkTailoring ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Wand2 className="w-4 h-4" />
          )}
          {bulkTailoring ? "Tailoring…" : "Tailor All"}
          {!bulkTailoring && needsTailoring.length > 0 && (
            <span className="text-xs bg-white/20 rounded-full px-1.5 py-0.5">{needsTailoring.length}</span>
          )}
        </button>
        <div className="text-xs text-gray-500 self-center">{filtered.length} jobs</div>
      </div>

      {bulkMsg && (
        <div className="text-xs text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2 flex items-center gap-2">
          {bulkTailoring && <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />}
          <span>{bulkMsg}</span>
        </div>
      )}

      <div className="overflow-x-auto card-glass">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Company</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Role</th>
              <th
                className="text-left px-4 py-3 text-gray-400 font-medium cursor-pointer hover:text-white"
                onClick={() => toggleSort("matchScore")}
              >
                <div className="flex items-center gap-1">
                  Match
                  {sortField === "matchScore" && (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                </div>
              </th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Status</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Platform</th>
              <th className="text-left px-4 py-3 text-gray-400 font-medium">Location</th>
              <th className="text-right px-4 py-3 text-gray-400 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map((job) => (
              <Fragment key={job.id}>
              <tr className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{job.companyName}</div>
                  {job.salary && <div className="text-xs text-gray-500">{job.salary}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="text-gray-300">{job.jobTitle}</div>
                  <div className="flex gap-1.5 mt-0.5 items-center flex-wrap">
                    {job.isRemote && <span className="text-xs text-cyan-400">Remote</span>}
                    {job.isEasyApply && <span className="text-xs text-green-400">Easy Apply</span>}
                    <VisaBadge status={job.sponsorshipStatus} />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ScoreBadge score={job.matchScore} />
                    {job.atsKeywordScore != null && (
                      <span
                        className={`text-xs font-medium ${
                          job.atsKeywordScore >= 80
                            ? "text-green-400"
                            : job.atsKeywordScore >= 60
                            ? "text-yellow-400"
                            : "text-red-400"
                        }`}
                        title="ATS keyword match"
                      >
                        {job.atsKeywordScore}%
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={job.application?.status || job.status} />
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500 capitalize">{job.platform}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500">{job.location || "N/A"}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => analyzeAts(job.id)}
                      disabled={loading === job.id + "_ats"}
                      className={`p-1.5 transition-colors disabled:opacity-50 ${
                        atsOpen === job.id ? "text-cyan-400" : "text-gray-500 hover:text-cyan-400"
                      }`}
                      title="Analyze ATS match"
                    >
                      <Gauge className={`w-3.5 h-3.5 ${loading === job.id + "_ats" ? "animate-pulse" : ""}`} />
                    </button>
                    <button
                      onClick={() => screenJob(job.id)}
                      disabled={loading === job.id + "_screen"}
                      className={`p-1.5 transition-colors disabled:opacity-50 ${
                        screenOpen === job.id ? "text-emerald-400" : "text-gray-500 hover:text-emerald-400"
                      }`}
                      title="Employer ATS: would they accept this résumé?"
                    >
                      <ShieldCheck className={`w-3.5 h-3.5 ${loading === job.id + "_screen" ? "animate-pulse" : ""}`} />
                    </button>
                    <a
                      href={job.applyUrl || job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    {!["TAILORED", "APPLYING", "APPLIED"].includes(job.status) && (
                      <button
                        onClick={() => tailorResume(job.id)}
                        disabled={loading === job.id + "_tailor"}
                        className="p-1.5 text-gray-500 hover:text-purple-400 transition-colors disabled:opacity-50"
                        title="Tailor resume"
                      >
                        <Wand2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {job.status === "TAILORED" && !job.application && (
                      <button
                        onClick={() => applyNow(job.id)}
                        disabled={loading === job.id + "_apply"}
                        className="p-1.5 text-gray-500 hover:text-green-400 transition-colors disabled:opacity-50"
                        title="Apply now"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {atsOpen === job.id && atsResults[job.id] && (
                <tr className="border-b border-gray-800/50 bg-gray-900/60">
                  <td colSpan={7} className="px-4 py-4">
                    <AtsPanel a={atsResults[job.id]} />
                  </td>
                </tr>
              )}
              {screenOpen === job.id && screenResults[job.id] && (
                <tr className="border-b border-gray-800/50 bg-gray-900/60">
                  <td colSpan={7} className="px-4 py-4">
                    <ScreeningPanel screening={screenResults[job.id]} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-600">No jobs found</div>
        )}
      </div>
    </div>
  );
}

function VisaBadge({ status }: { status: string | null }) {
  if (!status || status === "unknown") return null;
  if (status === "sponsors")
    return <span className="text-xs text-green-400" title="Mentions visa sponsorship">Sponsors</span>;
  if (status === "no_sponsorship")
    return <span className="text-xs text-red-400" title="States no sponsorship">No sponsor</span>;
  return null;
}

function FitBar({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  const c = value >= 80 ? "bg-green-500" : value >= 60 ? "bg-yellow-500" : "bg-red-500";
  const t = value >= 80 ? "text-green-400" : value >= 60 ? "text-yellow-400" : "text-red-400";
  return (
    <div className={`rounded-lg p-2 ${emphasize ? "bg-gray-800/80 ring-1 ring-gray-700" : "bg-gray-800/40"}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-400">{label}</span>
        <span className={`text-xs font-bold ${t}`}>{value}%</span>
      </div>
      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${c}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function AtsPanel({ a }: { a: AtsAnalysis }) {
  const color =
    a.score >= 80 ? "text-green-400" : a.score >= 60 ? "text-yellow-400" : "text-red-400";
  const bar =
    a.score >= 80 ? "bg-green-500" : a.score >= 60 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="space-y-3">
      {/* Score */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 uppercase tracking-wider">ATS Match</span>
        <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden max-w-xs">
          <div className={`h-full ${bar}`} style={{ width: `${a.score}%` }} />
        </div>
        <span className={`text-lg font-bold ${color}`}>{a.score}%</span>
      </div>

      {/* Fit breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <FitBar label="Technical" value={a.fit.technical} />
        <FitBar label="Experience" value={a.fit.experience} />
        <FitBar label="Education" value={a.fit.education} />
        <FitBar label="Overall" value={a.fit.overall} emphasize />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Strong matches */}
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Strong Matches ({a.strongMatches.length})</div>
          <div className="flex flex-wrap gap-1">
            {a.strongMatches.length === 0 && <span className="text-xs text-gray-600">None detected</span>}
            {a.strongMatches.map((k) => (
              <span key={k} className="text-xs bg-green-900/40 text-green-300 px-2 py-0.5 rounded">{k}</span>
            ))}
          </div>
        </div>
        {/* Missing keywords */}
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Missing Keywords ({a.missingKeywords.length})</div>
          <div className="flex flex-wrap gap-1">
            {a.missingKeywords.length === 0 && <span className="text-xs text-gray-600">None — great coverage</span>}
            {a.missingKeywords.map((k) => (
              <span key={k} className="text-xs bg-red-900/30 text-red-300 px-2 py-0.5 rounded">{k}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Suggestions */}
      {a.suggestions.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Suggestions</div>
          <ul className="space-y-1">
            {a.suggestions.map((s, i) => (
              <li key={i} className="text-xs text-gray-300 flex gap-2">
                <span className="text-cyan-400">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
