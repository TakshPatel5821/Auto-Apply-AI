"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { StatsCards } from "@/components/dashboard/StatsCards";
import { AutomationControls } from "@/components/dashboard/AutomationControls";
import { ResumeUpload } from "@/components/dashboard/ResumeUpload";
import { CustomSitesPanel } from "@/components/dashboard/CustomSitesPanel";
import { JobsTable } from "@/components/dashboard/JobsTable";
import { ApplicationsTable } from "@/components/dashboard/ApplicationsTable";
import { LogsConsole } from "@/components/dashboard/LogsConsole";
import {
  Briefcase,
  Send,
  FileText,
  Settings,
  LogOut,
  Download,
  Brain,
  RefreshCw,
} from "lucide-react";

type Tab = "jobs" | "applications" | "resume" | "memory" | "settings";

export default function DashboardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("jobs");
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

  useEffect(() => {
    fetchAll();
    const delay = automationState.isRunning && !automationState.isPaused ? 3000 : 15000;
    const interval = setInterval(fetchAll, delay);
    return () => clearInterval(interval);
  }, [fetchAll, automationState.isRunning, automationState.isPaused]);

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
    { id: "jobs", label: "Jobs", icon: Briefcase, count: stats.totalJobs },
    { id: "applications", label: "Applications", icon: Send, count: stats.totalApplications },
    { id: "resume", label: "Resume", icon: FileText, count: resumes.length },
    { id: "memory", label: "Memory", icon: Brain, count: memories.length },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <div className="text-gray-400 text-sm">Loading dashboard...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Briefcase className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white">AI Job Agent</span>
          </div>

          <div
            className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-full ${
              automationState.isRunning
                ? automationState.isPaused
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-green-500/20 text-green-400"
                : "bg-gray-800 text-gray-500"
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${
              automationState.isRunning && !automationState.isPaused
                ? "bg-green-400 animate-pulse"
                : automationState.isPaused
                ? "bg-yellow-400"
                : "bg-gray-600"
            }`} />
            {automationState.isRunning
              ? automationState.isPaused
                ? "Paused"
                : automationState.currentAction || "Running"
              : "Idle"}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={fetchAll}
              className="p-2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => exportExcel("jobs")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-gray-500 hover:text-red-400 transition-colors"
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
          {/* Left sidebar - Automation + Resume */}
          <div className="space-y-6">
            <AutomationControls
              state={automationState}
              resumes={resumes}
              onRefresh={fetchAll}
            />
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Resume</h3>
              <ResumeUpload resumes={resumes} onUpload={fetchAll} />
            </div>
            <CustomSitesPanel />
          </div>

          {/* Main content */}
          <div className="lg:col-span-3 space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? "bg-gray-800 text-white"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {tab.count !== undefined && tab.count > 0 && (
                    <span className="text-xs bg-gray-700 rounded-full px-1.5 py-0.5">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div>
              {activeTab === "jobs" && (
                <JobsTable jobs={jobs} onRefresh={fetchAll} />
              )}

              {activeTab === "applications" && (
                <div className="space-y-4">
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

              {activeTab === "resume" && (
                <div className="space-y-6">
                  {resumes.map((resume) => (
                    <div key={resume.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <div className="font-medium text-white">{resume.fileName}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {resume.yearsOfExperience?.toFixed(1) || "?"} years experience
                            {resume.isActive && (
                              <span className="ml-2 text-blue-400">Active</span>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-gray-600">
                          {resume._count?.tailoredVersions || 0} tailored versions
                        </div>
                      </div>
                      {resume.summary && (
                        <p className="text-sm text-gray-400 mb-4 line-clamp-3">{resume.summary}</p>
                      )}
                      <div className="space-y-2">
                        <div className="text-xs text-gray-600 uppercase tracking-wider">Skills</div>
                        <div className="flex flex-wrap gap-1">
                          {resume.skills.slice(0, 20).map((skill: string) => (
                            <span key={skill} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
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
      <form onSubmit={addMemory} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
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

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <span className="text-sm font-medium text-white">Saved Answers ({memories.length})</span>
        </div>
        <div className="divide-y divide-gray-800">
          {memories.map((m) => (
            <div key={m.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-300">{m.questionText}</div>
                <div className="text-sm text-blue-400 mt-0.5">{m.answerText}</div>
                <div className="flex gap-2 mt-1">
                  <span className="text-xs text-gray-600">{m.category}</span>
                  <span className="text-xs text-gray-700">used {m.usageCount}x</span>
                </div>
              </div>
              <button
                onClick={() => deleteMemory(m.id)}
                className="text-gray-600 hover:text-red-400 transition-colors text-xs"
              >
                Remove
              </button>
            </div>
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
        preferredTechStack: form.preferredTechStack.split(",").map((s: string) => s.trim()).filter(Boolean),
        minSalary: form.minSalary.trim() !== "" ? (parseInt(form.minSalary) || null) : null,
      }),
    });
    onSave();
  }

  return (
    <form onSubmit={save} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
      <h3 className="text-base font-semibold text-white">Search & Automation Settings</h3>

      {[
        { label: "Search Keywords (comma-separated)", key: "searchKeywords", placeholder: "Software Engineer, Frontend Engineer" },
        { label: "Locations (comma-separated)", key: "searchLocations", placeholder: "Remote, New York, San Francisco" },
        { label: "Blacklisted Companies", key: "blacklistCompanies", placeholder: "Company A, Company B" },
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
  );
}
