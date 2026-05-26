"use client";

import { useState } from "react";
import { ExternalLink, Wand2, Send, Filter, ChevronDown, ChevronUp } from "lucide-react";

interface Job {
  id: string;
  companyName: string;
  jobTitle: string;
  location: string | null;
  platform: string;
  matchScore: number | null;
  atsScore: number | null;
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
}

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
        <div className="text-xs text-gray-500 self-center">{filtered.length} jobs</div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
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
              <tr key={job.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{job.companyName}</div>
                  {job.salary && <div className="text-xs text-gray-500">{job.salary}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="text-gray-300">{job.jobTitle}</div>
                  <div className="flex gap-1 mt-0.5">
                    {job.isRemote && <span className="text-xs text-cyan-400">Remote</span>}
                    {job.isEasyApply && <span className="text-xs text-green-400">Easy Apply</span>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <ScoreBadge score={job.matchScore} />
                    {job.atsScore && <span className="text-xs text-gray-600">ATS:{job.atsScore.toFixed(0)}</span>}
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
