"use client";

import { useState } from "react";
import { Compass, Loader2, RefreshCw, Target, TrendingUp, Map as MapIcon, DollarSign } from "lucide-react";

interface CareerAdvice {
  summary: string;
  strengths: string[];
  skillGaps: { skill: string; demand: string; why: string }[];
  roadmap: { step: number; title: string; detail: string }[];
  targetRoles: string[];
  salaryInsight: string;
}
interface CareerData {
  advice: CareerAdvice;
  gaps: { skill: string; count: number }[];
  strengths: { skill: string; count: number }[];
  jobsAnalyzed: number;
}

const demandColor: Record<string, string> = {
  high: "bg-red-500/15 text-red-300 border-red-500/20",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/20",
  low: "bg-gray-700 text-gray-300 border-gray-600",
};

export function CareerAdvisorPanel() {
  const [data, setData] = useState<CareerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/career", { method: "POST" });
      const d = await res.json();
      if (!res.ok) setError(d.error || "Analysis failed");
      else setData(d);
    } catch {
      setError("Request failed");
    } finally {
      setLoading(false);
    }
  }

  if (!data && !loading) {
    return (
      <div className="card-glass p-10 text-center">
        <Compass className="w-8 h-8 text-blue-400 mx-auto mb-3" />
        <h3 className="text-white font-semibold mb-1">AI Career Advisor</h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto mb-5">
          Analyze your active résumé against the real demand in the jobs you&apos;ve scraped —
          skill gaps, in-demand strengths, and a prioritized learning roadmap.
        </p>
        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
        <button
          onClick={analyze}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Compass className="w-4 h-4" /> Analyze my career
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Analyzing your positioning… (~20-40s)
      </div>
    );
  }

  if (!data) return null;
  const { advice, gaps, strengths, jobsAnalyzed } = data;
  const maxGap = Math.max(1, ...gaps.map((g) => g.count));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">Based on {jobsAnalyzed} scraped jobs</span>
        <button
          onClick={analyze}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Re-analyze
        </button>
      </div>

      {/* Summary */}
      <div className="card-glass p-4">
        <p className="text-sm text-gray-200">{advice.summary}</p>
        {advice.targetRoles?.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-gray-500 flex items-center gap-1">
              <Target className="w-3 h-3" /> Well-positioned for:
            </span>
            {advice.targetRoles.map((r) => (
              <span key={r} className="text-xs bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded">{r}</span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Skill gaps with demand bars */}
        <div className="card-glass p-4">
          <h4 className="text-sm font-semibold text-gray-300 mb-3">Top skill gaps (by demand)</h4>
          {gaps.length === 0 ? (
            <p className="text-sm text-gray-600">No gaps detected — scrape more jobs for sharper signal.</p>
          ) : (
            <div className="space-y-2">
              {gaps.slice(0, 10).map((g) => (
                <div key={g.skill}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span className="text-gray-300">{g.skill}</span>
                    <span className="text-gray-600">{g.count}</span>
                  </div>
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-amber-500 to-red-500 rounded-full" style={{ width: `${(g.count / maxGap) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* In-demand strengths */}
        <div className="card-glass p-4">
          <h4 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4 text-emerald-400" /> Your in-demand strengths
          </h4>
          {advice.strengths?.length > 0 ? (
            <ul className="space-y-1.5 mb-3">
              {advice.strengths.map((s, i) => (
                <li key={i} className="text-sm text-gray-300 flex gap-2">
                  <span className="text-emerald-500 mt-0.5">✓</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {strengths.slice(0, 12).map((s) => (
              <span key={s.skill} className="text-xs bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded">
                {s.skill} <span className="text-emerald-600">{s.count}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Prioritized gaps from AI */}
      <div className="card-glass p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-3">Gaps that matter most</h4>
        <div className="space-y-2">
          {advice.skillGaps.map((g, i) => (
            <div key={i} className="flex items-start gap-3 bg-gray-800/50 rounded-lg p-3">
              <span className={`text-[10px] uppercase px-2 py-0.5 rounded-full border flex-shrink-0 ${demandColor[g.demand] || demandColor.low}`}>
                {g.demand}
              </span>
              <div>
                <div className="text-sm text-white font-medium">{g.skill}</div>
                <div className="text-sm text-gray-400">{g.why}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Roadmap */}
      <div className="card-glass p-4">
        <h4 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-1.5">
          <MapIcon className="w-4 h-4 text-blue-400" /> Learning roadmap
        </h4>
        <ol className="space-y-3">
          {advice.roadmap.map((step) => (
            <li key={step.step} className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">
                {step.step}
              </span>
              <div>
                <div className="text-sm text-white font-medium">{step.title}</div>
                <div className="text-sm text-gray-400">{step.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Salary insight */}
      {advice.salaryInsight && (
        <div className="card-glass p-4 flex items-start gap-2">
          <DollarSign className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-300">{advice.salaryInsight}</p>
        </div>
      )}
    </div>
  );
}
