"use client";

import { useState } from "react";
import { Play, Pause, Square, Zap, Search, BarChart2, FileEdit, Send as SendIcon } from "lucide-react";

interface AutomationState {
  isRunning: boolean;
  isPaused: boolean;
  mode: string;
  currentJob?: string;
  currentAction?: string;
  startedAt?: string;
}

interface Resume {
  id: string;
  fileName: string;
  isActive: boolean;
}

export function AutomationControls({
  state,
  resumes,
  onRefresh,
}: {
  state: AutomationState;
  resumes: Resume[];
  onRefresh: () => void;
}) {
  const [mode, setMode] = useState<"auto" | "manual">("manual");
  const [maxApps, setMaxApps] = useState(20);
  const [loading, setLoading] = useState(false);

  async function startAutomation() {
    setLoading(true);
    await fetch("/api/automation/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, maxApplicationsPerDay: maxApps }),
    });
    setLoading(false);
    onRefresh();
  }

  async function stopAutomation() {
    setLoading(true);
    await fetch("/api/automation/stop", { method: "POST" });
    setLoading(false);
    onRefresh();
  }

  async function pauseResume() {
    await fetch("/api/automation/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: state.isPaused ? "resume" : "pause" }),
    });
    onRefresh();
  }

  async function startScrapeOnly() {
    setLoading(true);
    const activeResume = resumes.find((r) => r.isActive);
    await fetch("/api/jobs/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeId: activeResume?.id,
        platforms: ["linkedin", "indeed"],
      }),
    });
    setLoading(false);
    onRefresh();
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <div className="flex items-center gap-2 mb-6">
        <div className={`w-2.5 h-2.5 rounded-full ${
          state.isRunning
            ? state.isPaused
              ? "bg-yellow-400"
              : "bg-green-400 animate-pulse"
            : "bg-gray-600"
        }`} />
        <h2 className="text-lg font-semibold text-white">Automation Engine</h2>
        <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${
          state.isRunning
            ? state.isPaused
              ? "bg-yellow-400/20 text-yellow-400"
              : "bg-green-400/20 text-green-400"
            : "bg-gray-700 text-gray-400"
        }`}>
          {state.isRunning ? (state.isPaused ? "PAUSED" : "RUNNING") : "STOPPED"}
        </span>
      </div>

      {state.isRunning && (
        <div className="mb-4 space-y-3">
          <PhaseProgress action={state.currentAction} />
          {state.currentJob && (
            <div className="text-xs text-gray-500 truncate">{state.currentJob}</div>
          )}
        </div>
      )}

      {!state.isRunning && (
        <div className="space-y-4 mb-6">
          <div>
            <label className="text-xs text-gray-400 block mb-2">Application Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode("manual")}
                className={`py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                  mode === "manual"
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                }`}
              >
                Manual Review
              </button>
              <button
                onClick={() => setMode("auto")}
                className={`py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                  mode === "auto"
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                }`}
              >
                <Zap className="w-3.5 h-3.5 inline mr-1" />
                Full Auto
              </button>
            </div>
            {mode === "auto" && (
              <p className="text-xs text-yellow-400 mt-2">
                Auto mode will apply to jobs automatically without review
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-2">
              Max Applications / Day: {maxApps}
            </label>
            <input
              type="range"
              min={1}
              max={50}
              value={maxApps}
              onChange={(e) => setMaxApps(parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {!state.isRunning ? (
          <>
            <button
              onClick={startAutomation}
              disabled={loading || resumes.length === 0}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors"
            >
              <Play className="w-4 h-4" />
              Start Full Cycle
            </button>
            <button
              onClick={startScrapeOnly}
              disabled={loading}
              className="flex items-center justify-center gap-1 py-2.5 px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
            >
              Scrape Only
            </button>
          </>
        ) : (
          <>
            <button
              onClick={pauseResume}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-medium text-sm transition-colors"
            >
              <Pause className="w-4 h-4" />
              {state.isPaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={stopAutomation}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium text-sm transition-colors"
            >
              <Square className="w-4 h-4" />
              Stop
            </button>
          </>
        )}
      </div>

      {resumes.length === 0 && (
        <p className="text-xs text-red-400 mt-3 text-center">
          Upload a resume to start automation
        </p>
      )}
    </div>
  );
}

const PHASES = [
  { label: "Scrape", icon: Search, match: "scraping" },
  { label: "Analyze", icon: BarChart2, match: "analyzing" },
  { label: "Tailor", icon: FileEdit, match: "tailoring" },
  { label: "Apply", icon: SendIcon, match: "applying" },
];

function PhaseProgress({ action }: { action?: string }) {
  const lower = (action || "").toLowerCase();
  const activeIdx = PHASES.findIndex((p) => lower.includes(p.match));
  const current = activeIdx === -1 ? 0 : activeIdx;

  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <div className="text-xs text-gray-400 mb-2">{action || "Processing..."}</div>
      <div className="flex items-center gap-1">
        {PHASES.map((phase, i) => {
          const Icon = phase.icon;
          const isDone = i < current;
          const isActive = i === current;
          return (
            <div key={phase.label} className="flex items-center gap-1 flex-1">
              <div className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded flex-1 justify-center ${
                isDone
                  ? "bg-green-900/40 text-green-400"
                  : isActive
                  ? "bg-blue-900/40 text-blue-400 ring-1 ring-blue-500"
                  : "bg-gray-700/40 text-gray-600"
              }`}>
                <Icon className={`w-3 h-3 ${isActive ? "animate-pulse" : ""}`} />
                <span className="hidden sm:inline">{phase.label}</span>
              </div>
              {i < PHASES.length - 1 && (
                <div className={`w-2 h-px flex-shrink-0 ${isDone || isActive ? "bg-blue-700" : "bg-gray-700"}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
