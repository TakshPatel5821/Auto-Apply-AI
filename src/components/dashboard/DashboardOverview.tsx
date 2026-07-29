"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Upload, FileText, Sparkles, Search, Brain, FileBarChart, Send, Play, Loader2,
  Briefcase, Target, CheckCircle2, TrendingUp,
} from "lucide-react";

// The "Ariana-style" overview, wired to the real job-automation pipeline.
// Everything here is derived from data already loaded on the dashboard page.

interface Job { id: string; companyName: string; jobTitle: string; platform?: string; matchScore?: number | null; atsScore?: number | null; status?: string; }
interface App {
  id: string;
  status: string;
  updatedAt?: string;
  appliedAt?: string | null;
  job: { companyName: string; jobTitle: string; platform?: string; matchScore?: number | null };
  tailoredResume?: { atsScore?: number | null } | null;
}
interface Stats { totalJobs: number; analyzedJobs: number; appliedToday: number; totalApplications: number; scrapedToday: number; fitJobs: number; }

const STEPS = [
  { icon: Upload, title: "Scrape Jobs", sub: "LinkedIn · Indeed · ATS", key: "scrap" },
  { icon: Search, title: "Match & Score", sub: "Fit + ATS keyword %", key: "analy" },
  { icon: Sparkles, title: "Tailor Résumé", sub: "JD-specific summary", key: "tailor" },
  { icon: FileText, title: "Generate PDF", sub: "Tectonic · 1 page", key: "pdf" },
  { icon: Brain, title: "Cover Letter", sub: "Validated · no hallucination", key: "cover" },
  { icon: Send, title: "Apply", sub: "Easy Apply + 13 ATS", key: "apply" },
  { icon: FileBarChart, title: "Track", sub: "Status + analytics", key: "track" },
];

const DONUT_COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#a855f7", "#3b82f6", "#64748b"];

const STATUS_STYLE: Record<string, string> = {
  SUBMITTED: "bg-green-500/15 text-green-400",
  APPLIED: "bg-green-500/15 text-green-400",
  APPROVED: "bg-blue-500/15 text-blue-400",
  PENDING: "bg-gray-500/15 text-gray-400",
  IN_PROGRESS: "bg-violet-500/15 text-violet-400",
  INTERVIEW: "bg-teal-500/15 text-teal-400",
  OFFER: "bg-amber-500/15 text-amber-400",
  FAILED: "bg-red-500/15 text-red-400",
  REJECTED: "bg-red-500/15 text-red-400",
};

function StatCard({ icon: Icon, label, value, trend, accent }: { icon: typeof Briefcase; label: string; value: string; trend?: string; accent: string; }) {
  return (
    <div className="card-glass p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-gray-500">{label}</div>
          <div className="text-2xl font-bold text-white mt-1">{value}</div>
          {trend && (
            <div className="text-xs text-green-400 mt-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> {trend}
            </div>
          )}
        </div>
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${accent}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
}

export function DashboardOverview({
  stats, jobs, applications, automationState, onRefresh,
}: {
  stats: Stats;
  jobs: Job[];
  applications: App[];
  automationState: { isRunning?: boolean; isPaused?: boolean; currentAction?: string };
  onRefresh: () => void;
}) {
  const [executing, setExecuting] = useState(false);

  // Which pipeline step is "live" (best-effort from the running action text).
  const activeStep = useMemo(() => {
    const a = (automationState.currentAction || "").toLowerCase();
    if (!automationState.isRunning) return -1;
    return STEPS.findIndex((s) => a.includes(s.key));
  }, [automationState]);

  const avgMatch = useMemo(() => {
    const vals = jobs.map((j) => j.matchScore).filter((v): v is number => typeof v === "number");
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }, [jobs]);

  const goodFit = useMemo(() => jobs.filter((j) => (j.matchScore ?? 0) >= 70).length, [jobs]);

  // Donut: jobs grouped by source/platform (top 5 + Others).
  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const j of jobs) {
      const k = (j.platform || "other").replace(/^\w/, (c) => c.toUpperCase());
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5).reduce((a, [, v]) => a + v, 0);
    const data = top.map(([name, value]) => ({ name, value }));
    if (rest) data.push({ name: "Others", value: rest });
    return data;
  }, [jobs]);

  // Match-score distribution (line), bucketed 0-20 … 80-100.
  const distribution = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0];
    for (const j of jobs) {
      const s = j.matchScore;
      if (typeof s !== "number") continue;
      buckets[Math.min(4, Math.floor(s / 20))]++;
    }
    const labels = ["0-20", "20-40", "40-60", "60-80", "80-100"];
    return buckets.map((value, i) => ({ name: labels[i], value }));
  }, [jobs]);

  // AI-output example from the most recent tailored application.
  const example = useMemo(() => {
    const app = applications.find((a) => a.tailoredResume) || applications[0];
    if (!app) return null;
    return {
      company: app.job.companyName,
      role: app.job.jobTitle,
      match_score: typeof app.job.matchScore === "number" ? +(app.job.matchScore / 100).toFixed(2) : null,
      ats_score: app.tailoredResume?.atsScore ?? null,
      source: app.job.platform || "unknown",
      recommended_action: (app.job.matchScore ?? 0) >= 70 ? "apply" : "review",
      status: app.status,
    };
  }, [applications]);

  const recent = useMemo(
    () => [...applications]
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .slice(0, 6),
    [applications]
  );

  async function execute() {
    if (executing || automationState.isRunning) return;
    if (!confirm("Run the workflow now? This scrapes + analyzes + tailors in manual mode (it won't auto-submit).")) return;
    setExecuting(true);
    await fetch("/api/automation/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    }).catch(() => {});
    setExecuting(false);
    onRefresh();
  }

  const running = !!automationState.isRunning;

  return (
    <div className="space-y-5">
      {/* ── Workflow pipeline ─────────────────────────────────────────── */}
      <div className="card-glass p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-400" /> AI Agent Workflow Pipeline
          </h3>
          <button
            onClick={execute}
            disabled={executing || running}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
          >
            {executing || running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? "Running…" : "Execute Workflow"}
          </button>
        </div>
        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
          {STEPS.map((s, i) => {
            const live = i === activeStep;
            return (
              <div key={s.title} className="flex items-center gap-1 flex-shrink-0">
                <div className={`w-[112px] rounded-xl border p-3 text-center transition-colors ${
                  live ? "border-violet-500/60 bg-violet-500/10 shadow-lg shadow-violet-500/10" : "border-white/10 bg-white/[0.03]"
                }`}>
                  <div className={`w-8 h-8 mx-auto rounded-lg flex items-center justify-center mb-1.5 ${
                    live ? "bg-violet-500/30 text-violet-300" : "bg-white/5 text-gray-400"
                  }`}>
                    <s.icon className="w-4 h-4" />
                  </div>
                  <div className="text-[11px] font-medium text-gray-200 leading-tight">{i + 1}. {s.title}</div>
                  <div className="text-[9px] text-gray-500 mt-0.5 leading-tight">{s.sub}</div>
                </div>
                {i < STEPS.length - 1 && <div className="w-3 h-px bg-white/15" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Briefcase} label="Jobs Processed" value={String(stats.totalJobs)} trend={stats.scrapedToday ? `+${stats.scrapedToday} today` : undefined} accent="bg-blue-500/15 text-blue-400" />
        <StatCard icon={Target} label="Avg. Match" value={`${avgMatch}%`} accent="bg-violet-500/15 text-violet-400" />
        <StatCard icon={CheckCircle2} label="Strong Matches" value={String(goodFit)} accent="bg-teal-500/15 text-teal-400" />
        <StatCard icon={Send} label="Applications" value={String(stats.totalApplications)} trend={stats.appliedToday ? `+${stats.appliedToday} today` : undefined} accent="bg-amber-500/15 text-amber-400" />
      </div>

      {/* ── Donut + JSON + line ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Donut: sources */}
        <div className="card-glass p-4">
          <h4 className="text-xs font-semibold text-gray-300 mb-2">Top Sources</h4>
          {sources.length ? (
            <div className="relative">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={sources} dataKey="value" nameKey="name" innerRadius={50} outerRadius={75} paddingAngle={2} stroke="none">
                    {sources.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#0b0f17", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-xl font-bold text-white">{jobs.length}</div>
                <div className="text-[10px] text-gray-500">Total</div>
              </div>
            </div>
          ) : <div className="h-[180px] flex items-center justify-center text-xs text-gray-600">No jobs yet</div>}
          <div className="mt-2 space-y-1">
            {sources.slice(0, 5).map((s, i) => (
              <div key={s.name} className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-gray-400">
                  <span className="w-2 h-2 rounded-sm" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />{s.name}
                </span>
                <span className="text-gray-500">{Math.round((s.value / jobs.length) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* AI output example */}
        <div className="card-glass p-4">
          <h4 className="text-xs font-semibold text-gray-300 mb-2">AI Analysis Output (Example)</h4>
          <pre className="text-[11px] leading-relaxed text-teal-300/90 bg-black/30 rounded-lg p-3 overflow-auto h-[230px] font-mono">
{example ? JSON.stringify(example, null, 2) : "// No tailored applications yet.\n// Run the workflow to see output."}
          </pre>
        </div>

        {/* Distribution line */}
        <div className="card-glass p-4">
          <h4 className="text-xs font-semibold text-gray-300 mb-2">Match-Score Distribution</h4>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={distribution} margin={{ top: 10, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#0b0f17", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2} dot={{ r: 3, fill: "#a855f7" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Recent executions ─────────────────────────────────────────── */}
      <div className="card-glass p-4">
        <h4 className="text-xs font-semibold text-gray-300 mb-3">Recent Executions</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/[0.06]">
                <th className="text-left font-medium py-2">Company</th>
                <th className="text-left font-medium py-2">Role</th>
                <th className="text-left font-medium py-2">Status</th>
                <th className="text-left font-medium py-2">Match</th>
                <th className="text-left font-medium py-2">Source</th>
                <th className="text-left font-medium py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <tr key={a.id} className="border-b border-white/[0.04]">
                  <td className="py-2 text-white font-medium">{a.job.companyName}</td>
                  <td className="py-2 text-gray-400 max-w-[200px] truncate">{a.job.jobTitle}</td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded-md ${STATUS_STYLE[a.status] || "bg-gray-500/15 text-gray-400"}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="py-2 text-gray-300">{typeof a.job.matchScore === "number" ? `${a.job.matchScore.toFixed(0)}%` : "—"}</td>
                  <td className="py-2 text-gray-400">{a.job.platform || "—"}</td>
                  <td className="py-2 text-gray-500">{a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-gray-600">No executions yet — run the workflow.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
