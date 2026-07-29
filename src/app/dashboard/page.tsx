"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { AnalyticsPanel } from "@/components/dashboard/AnalyticsPanel";
import { CareerAdvisorPanel } from "@/components/dashboard/CareerAdvisorPanel";
import { AutomationControls } from "@/components/dashboard/AutomationControls";
import { ResumeUpload } from "@/components/dashboard/ResumeUpload";
import { CustomSitesPanel } from "@/components/dashboard/CustomSitesPanel";
import { JobsTable } from "@/components/dashboard/JobsTable";
import { ApplicationsTable } from "@/components/dashboard/ApplicationsTable";
import { EmailClassifierPanel } from "@/components/dashboard/EmailClassifierPanel";
import { ProfilePanel } from "@/components/dashboard/ProfilePanel";
import { ResumeCard } from "@/components/dashboard/ResumeCard";
import { LogsConsole } from "@/components/dashboard/LogsConsole";
import { QuickSetupPanel } from "@/components/dashboard/QuickSetupPanel";
import { DashboardOverview } from "@/components/dashboard/DashboardOverview";
import { AtsCheckerModal } from "@/components/dashboard/AtsCheckerModal";
import { GithubProjectsPanel } from "@/components/dashboard/GithubProjectsPanel";
import {
  Briefcase,
  Send,
  FileText,
  Settings,
  LogOut,
  Download,
  Brain,
  RefreshCw,
  BarChart3,
  Compass,
  Lock,
  Unlock,
  Trash2,
  Sparkles,
  UserCircle,
  LayoutDashboard,
} from "lucide-react";

type Tab = "dashboard" | "jobs" | "applications" | "analytics" | "career" | "profile" | "resume" | "memory" | "settings";

export default function DashboardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(true);

  const [resumes, setResumes] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [applications, setApplications] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [automationState, setAutomationState] = useState<any>({
    isRunning: false,
    isPaused: false,
    mode: "manual",
    jobsScraped: 0,
    jobsAnalyzed: 0,
    applicationsSubmitted: 0,
    applicationsToday: 0,
  });
  const [stats, setStats] = useState({
    totalJobs: 0,
    analyzedJobs: 0,
    appliedToday: 0,
    totalApplications: 0,
    scrapedToday: 0,
    fitJobs: 0,
  });
  const [memories, setMemories] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);

  const fetchAll = useCallback(async () => {
    const [
      resumesRes,
      jobsRes,
      appsRes,
      statusRes,
      logsRes,
    ] = await Promise.all([
      fetch("/api/resume/upload"),
      fetch("/api/jobs/list?limit=200"),
      fetch("/api/applications/list"),
      fetch("/api/automation/status"),
      fetch("/api/logs?limit=100"),
    ]);

    if (resumesRes.status === 401) {
      router.push("/");
      return;
    }

    const [resumeData, jobsData, appsData, statusData, logsData] = await Promise.all([
      resumesRes.json(),
      jobsRes.json(),
      appsRes.json(),
      statusRes.json(),
      logsRes.json(),
    ]);

    setResumes(resumeData.resumes || []);
    setJobs(jobsData.jobs || []);
    setApplications(appsData.applications || []);
    setAutomationState(statusData.state || {});
    setStats(statusData.stats || {});
    setLogs(logsData.logs || []);
    setLoading(false);
  }, [router]);

  const fetchMemory = useCallback(async () => {
    const res = await fetch("/api/memory");
    if (res.ok) {
      const data = await res.json();
      setMemories(data.memories || []);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
    }
  }, []);

  // Initial load of everything.
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Live updates via Server-Sent Events: state, stats, and logs stream in with
  // no polling. Heavy tables (jobs/applications) are refetched only when the
  // job/application counts actually change.
  const totalsRef = useRef({ totalJobs: -1, totalApplications: -1 });
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("state", (e) => setAutomationState(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("logs", (e) => setLogs(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("stats", (e) => {
      const s = JSON.parse((e as MessageEvent).data);
      setStats(s);
      if (
        s.totalJobs !== totalsRef.current.totalJobs ||
        s.totalApplications !== totalsRef.current.totalApplications
      ) {
        totalsRef.current = { totalJobs: s.totalJobs, totalApplications: s.totalApplications };
        fetchAll();
      }
    });
    return () => es.close();
  }, [fetchAll]);

  useEffect(() => {
    if (activeTab === "memory") fetchMemory();
    if (activeTab === "settings") fetchSettings();
  }, [activeTab, fetchMemory, fetchSettings]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
  }

  async function exportExcel(type: "jobs" | "applications") {
    const a = document.createElement("a");
    a.href = `/api/export?type=${type}`;
    a.download = `${type}_export.xlsx`;
    a.click();
  }

  const tabs: { id: Tab; label: string; icon: any; count?: number }[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "jobs", label: "Jobs", icon: Briefcase, count: stats.totalJobs },
    { id: "applications", label: "Applications", icon: Send, count: stats.totalApplications },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "career", label: "Career", icon: Compass },
    { id: "profile", label: "Profile", icon: UserCircle },
    { id: "resume", label: "Resume", icon: FileText, count: resumes.length },
    { id: "memory", label: "Memory", icon: Brain, count: memories.length },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <div className="text-gray-400 text-sm">Loading dashboard…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-white">
      {/* Header */}
      <header className="border-b border-white/[0.06] bg-gray-950/70 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Briefcase className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg text-gradient">AI Job Agent</span>
          </div>

          <div
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${
              automationState.isRunning
                ? automationState.isPaused
                  ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                  : "bg-green-500/10 text-green-400 border-green-500/20"
                : "bg-white/5 text-gray-500 border-white/10"
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${
              automationState.isRunning && !automationState.isPaused
                ? "bg-green-400 animate-pulse shadow-[0_0_6px_2px_rgba(74,222,128,0.5)]"
                : automationState.isPaused
                ? "bg-yellow-400"
                : "bg-gray-600"
            }`} />
            <span className="max-w-[260px] truncate">{automationState.isRunning
              ? automationState.isPaused
                ? "Paused"
                : automationState.currentAction || "Running"
              : "Idle"}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <AtsCheckerModal />
            <button
              onClick={fetchAll}
              className="p-2 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => exportExcel("jobs")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title="Log out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
        {/* Stats */}
        <StatsCards stats={stats} automationState={automationState} />

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left sidebar - Quick Setup + Automation + Resume */}
          <div className="space-y-6">
            <QuickSetupPanel onSave={fetchAll} />
            <AutomationControls
              state={automationState}
              resumes={resumes}
              onRefresh={fetchAll}
            />
            <div className="card-glass p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Resume</h3>
              <ResumeUpload resumes={resumes} onUpload={fetchAll} />
            </div>
            <CustomSitesPanel />
          </div>

          {/* Main content */}
          <div className="lg:col-span-3 space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 card-glass p-1 overflow-x-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                    activeTab === tab.id
                      ? "bg-gradient-to-br from-blue-500/90 to-violet-600/90 text-white shadow-lg shadow-blue-500/20"
                      : "text-gray-500 hover:text-gray-200 hover:bg-white/5"
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {tab.count !== undefined && tab.count > 0 && (
                    <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                      activeTab === tab.id ? "bg-white/20" : "bg-white/10"
                    }`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="animate-fade-in">
              {activeTab === "dashboard" && (
                <DashboardOverview
                  stats={stats}
                  jobs={jobs}
                  applications={applications}
                  automationState={automationState}
                  onRefresh={fetchAll}
                />
              )}

              {activeTab === "jobs" && (
                <JobsTable jobs={jobs} onRefresh={fetchAll} />
              )}

              {activeTab === "applications" && (
                <div className="space-y-4">
                  <EmailClassifierPanel onApplied={fetchAll} />
                  <div className="flex justify-end">
                    <button
                      onClick={() => exportExcel("applications")}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export Applications
                    </button>
                  </div>
                  <ApplicationsTable
                    applications={applications}
                    onRefresh={fetchAll}
                  />
                </div>
              )}

              {activeTab === "analytics" && <AnalyticsPanel />}

              {activeTab === "career" && <CareerAdvisorPanel />}

              {activeTab === "profile" && <ProfilePanel />}

              {activeTab === "resume" && (
                <div className="space-y-6">
                  <GithubProjectsPanel />
                  {resumes.map((resume) => (
                    <ResumeCard key={resume.id} resume={resume} onSaved={fetchAll} />
                  ))}
                  {resumes.length === 0 && (
                    <div className="text-center py-12 text-gray-600">
                      Upload a resume using the panel on the left
                    </div>
                  )}
                </div>
              )}

              {activeTab === "memory" && (
                <MemoryTab memories={memories} onRefresh={fetchMemory} />
              )}

              {activeTab === "settings" && settings !== undefined && (
                <SettingsTab settings={settings} onSave={fetchSettings} />
              )}
            </div>
          </div>
        </div>

        {/* Logs */}
        <LogsConsole logs={logs} onClear={fetchAll} />
      </div>
    </div>
  );
}

function MemoryTab({
  memories,
  onRefresh,
}: {
  memories: any[];
  onRefresh: () => void;
}) {
  async function deleteMemory(id: string) {
    await fetch("/api/memory", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    onRefresh();
  }

  async function toggleLock(id: string, locked: boolean) {
    await fetch("/api/memory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, locked }),
    });
    onRefresh();
  }

  async function saveEdit(id: string, answer: string) {
    await fetch("/api/memory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer }),
    });
    onRefresh();
  }

  async function cleanup() {
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup" }),
    });
    const data = await res.json();
    alert(`Removed ${data.removed ?? 0} bad/mismatched answers.`);
    onRefresh();
  }

  async function addMemory(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: data.get("question"),
        answer: data.get("answer"),
        category: data.get("category"),
      }),
    });
    form.reset();
    onRefresh();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={addMemory} className="card-glass p-4 space-y-3">
        <h3 className="text-sm font-medium text-white">Add Application Answer</h3>
        <input
          name="question"
          placeholder="Question text (e.g. 'Are you authorized to work in the US?')"
          required
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <input
          name="answer"
          placeholder="Your answer"
          required
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <div className="flex gap-2">
          <select
            name="category"
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none"
          >
            {["GENERAL", "VISA_SPONSORSHIP", "WORK_AUTHORIZATION", "SALARY", "EXPERIENCE", "RELOCATION", "DEMOGRAPHICS", "AVAILABILITY"].map((c) => (
              <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
            ))}
          </select>
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
      </form>

      <div className="card-glass overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <span className="text-sm font-medium text-white">Saved Answers ({memories.length})</span>
          <button
            onClick={cleanup}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-amber-400 transition-colors"
            title="Remove answers that don't match their field (e.g. email saved into 'Degree')"
          >
            <Sparkles className="w-3.5 h-3.5" /> Clean up bad answers
          </button>
        </div>
        <div className="divide-y divide-gray-800">
          {memories.map((m) => (
            <MemoryRow
              key={m.id}
              m={m}
              onDelete={() => deleteMemory(m.id)}
              onToggleLock={() => toggleLock(m.id, !m.locked)}
              onSaveEdit={(ans) => saveEdit(m.id, ans)}
            />
          ))}
          {memories.length === 0 && (
            <div className="text-center py-8 text-gray-600 text-sm">
              No saved answers. The AI will remember answers as you apply to jobs.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryRow({
  m,
  onDelete,
  onToggleLock,
  onSaveEdit,
}: {
  m: any;
  onDelete: () => void;
  onToggleLock: () => void;
  onSaveEdit: (answer: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(m.answerText);

  return (
    <div className={`px-4 py-3 flex items-start justify-between gap-3 ${m.locked ? "bg-blue-950/20" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-300 flex items-center gap-1.5">
          {m.locked && <Lock className="w-3 h-3 text-blue-400 flex-shrink-0" />}
          {m.questionText}
        </div>
        {editing ? (
          <div className="flex gap-2 mt-1">
            <input
              value={val}
              onChange={(e) => setVal(e.target.value)}
              className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => { onSaveEdit(val); setEditing(false); }}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded"
            >
              Save
            </button>
            <button onClick={() => { setVal(m.answerText); setEditing(false); }} className="text-gray-500 text-xs px-1">
              Cancel
            </button>
          </div>
        ) : (
          <div
            className="text-sm text-blue-400 mt-0.5 cursor-pointer hover:underline"
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {m.answerText}
          </div>
        )}
        <div className="flex gap-2 mt-1">
          <span className="text-xs text-gray-600">{m.category}</span>
          <span className="text-xs text-gray-700">used {m.usageCount}x</span>
          {m.locked && <span className="text-xs text-blue-500">locked</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onToggleLock}
          className={`transition-colors ${m.locked ? "text-blue-400 hover:text-blue-300" : "text-gray-600 hover:text-blue-400"}`}
          title={m.locked ? "Unlock (allow AI to update)" : "Lock (AI can't change this answer)"}
        >
          {m.locked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
        </button>
        <button onClick={onDelete} className="text-gray-600 hover:text-red-400 transition-colors" title="Remove">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function SettingsTab({
  settings,
  onSave,
}: {
  settings: any;
  onSave: () => void;
}) {
  const buildForm = (s: any) => ({
    searchKeywords: s?.searchKeywords?.join(", ") || "Software Engineer Intern, Cloud Engineer Intern, Cybersecurity Intern, Software Developer Intern",
    searchLocations: s?.searchLocations?.join(", ") || "Arlington TX, Dallas TX, Fort Worth TX, Remote",
    remoteOnly: s?.remoteOnly ?? false,
    requireSponsorship: s?.requireSponsorship ?? false,
    maxApplicationsPerDay: s?.maxApplicationsPerDay ?? 20,
    autoApply: s?.autoApply ?? false,
    blacklistCompanies: s?.blacklistCompanies?.join(", ") || "",
    preferredCompanies: s?.preferredCompanies?.join(", ") || "",
    preferredTechStack: s?.preferredTechStack?.join(", ") || "Python, JavaScript, PHP, Azure, MySQL, React",
    minSalary: s?.minSalary != null ? String(s.minSalary) : "",
  });

  const [form, setForm] = useState(() => buildForm(settings));

  useEffect(() => {
    setForm(buildForm(settings));
  }, [settings]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchKeywords: form.searchKeywords.split(",").map((s: string) => s.trim()).filter(Boolean),
        searchLocations: form.searchLocations.split(",").map((s: string) => s.trim()).filter(Boolean),
        remoteOnly: form.remoteOnly,
        requireSponsorship: form.requireSponsorship,
        maxApplicationsPerDay: form.maxApplicationsPerDay,
        autoApply: form.autoApply,
        blacklistCompanies: form.blacklistCompanies.split(",").map((s: string) => s.trim()).filter(Boolean),
        preferredCompanies: form.preferredCompanies.split(",").map((s: string) => s.trim()).filter(Boolean),
        preferredTechStack: form.preferredTechStack.split(",").map((s: string) => s.trim()).filter(Boolean),
        minSalary: form.minSalary.trim() !== "" ? (parseInt(form.minSalary) || null) : null,
      }),
    });
    onSave();
  }

  return (
    <div className="space-y-5">
    <CredentialsCard />
    <form onSubmit={save} className="card-glass p-6 space-y-5">
      <h3 className="text-base font-semibold text-white">Search & Automation Settings</h3>

      {[
        { label: "Search Keywords (comma-separated)", key: "searchKeywords", placeholder: "Software Engineer, Frontend Engineer" },
        { label: "Locations (comma-separated)", key: "searchLocations", placeholder: "Remote, New York, San Francisco" },
        { label: "Blacklisted Companies", key: "blacklistCompanies", placeholder: "Company A, Company B" },
        { label: "Greenhouse Companies (for Greenhouse source)", key: "preferredCompanies", placeholder: "stripe, airbnb, databricks" },
        { label: "Preferred Tech Stack", key: "preferredTechStack", placeholder: "React, TypeScript, Python" },
      ].map((field) => (
        <div key={field.key}>
          <label className="text-xs text-gray-400 block mb-1.5">{field.label}</label>
          <input
            type="text"
            value={form[field.key as keyof typeof form] as string}
            onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      ))}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1.5">
            Max Applications/Day: {form.maxApplicationsPerDay}
          </label>
          <input
            type="range"
            min={1}
            max={50}
            value={form.maxApplicationsPerDay}
            onChange={(e) => setForm({ ...form, maxApplicationsPerDay: parseInt(e.target.value) })}
            className="w-full accent-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1.5">Minimum Salary ($)</label>
          <input
            type="number"
            value={form.minSalary}
            onChange={(e) => setForm({ ...form, minSalary: e.target.value })}
            placeholder="80000"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {[
          { key: "remoteOnly", label: "Remote Only" },
          { key: "requireSponsorship", label: "Require Sponsorship" },
          { key: "autoApply", label: "Full Auto Apply" },
        ].map((toggle) => (
          <label key={toggle.key} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form[toggle.key as keyof typeof form] as boolean}
              onChange={(e) => setForm({ ...form, [toggle.key]: e.target.checked })}
              className="w-4 h-4 accent-blue-500"
            />
            <span className="text-sm text-gray-300">{toggle.label}</span>
          </label>
        ))}
      </div>

      {form.autoApply && (
        <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 text-xs text-yellow-400">
          Full Auto Apply will submit applications without manual review. Use with caution.
        </div>
      )}

      <button
        type="submit"
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
      >
        Save Settings
      </button>
    </form>
    </div>
  );
}

function CredentialsCard() {
  const [status, setStatus] = useState<{ linkedin: boolean; ats: boolean } | null>(null);
  const [form, setForm] = useState({ linkedinEmail: "", linkedinPassword: "", atsEmail: "", atsPassword: "" });
  const [msg, setMsg] = useState("");

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/credentials");
    if (res.ok) setStatus((await res.json()).status);
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setStatus((await res.json()).status);
      setForm({ linkedinEmail: "", linkedinPassword: "", atsEmail: "", atsPassword: "" });
      setMsg("Saved — encrypted at rest");
      setTimeout(() => setMsg(""), 3000);
    }
  }

  async function migrate() {
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "migrate" }),
    });
    const data = await res.json();
    setStatus(data.status);
    setMsg(data.migrated ? "Imported .env credentials (now encrypted)" : "Nothing to import");
    setTimeout(() => setMsg(""), 3000);
  }

  return (
    <form onSubmit={save} className="card-glass p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Lock className="w-4 h-4 text-emerald-400" />
        <h3 className="text-base font-semibold text-white">Credentials (encrypted)</h3>
      </div>
      <p className="text-xs text-gray-500">
        Passwords are encrypted at rest (AES-256-GCM) — never stored in plaintext. Leave a field blank to keep the existing value.
      </p>

      <div className="flex gap-3 text-xs">
        <span className={status?.linkedin ? "text-emerald-400" : "text-gray-500"}>
          {status?.linkedin ? "✓ LinkedIn saved" : "○ LinkedIn not set"}
        </span>
        <span className={status?.ats ? "text-emerald-400" : "text-gray-500"}>
          {status?.ats ? "✓ ATS saved" : "○ ATS not set"}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[
          { key: "linkedinEmail", label: "LinkedIn Email", type: "text" },
          { key: "linkedinPassword", label: "LinkedIn Password", type: "password" },
          { key: "atsEmail", label: "ATS Email (Workday etc.)", type: "text" },
          { key: "atsPassword", label: "ATS Password", type: "password" },
        ].map((f) => (
          <div key={f.key}>
            <label className="text-xs text-gray-400 block mb-1">{f.label}</label>
            <input
              type={f.type}
              value={form[f.key as keyof typeof form]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              placeholder="•••• (unchanged)"
              autoComplete="off"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        ))}
      </div>

      {msg && <div className="text-xs text-emerald-400">{msg}</div>}

      <div className="flex gap-2">
        <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors">
          Save Encrypted
        </button>
        <button type="button" onClick={migrate} className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 text-sm rounded-lg transition-colors">
          Import from .env
        </button>
      </div>
    </form>
  );
}
