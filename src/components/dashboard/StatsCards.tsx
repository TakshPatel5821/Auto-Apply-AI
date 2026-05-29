"use client";

import { Briefcase, Send, TrendingUp, Calendar, Target, Activity, CheckCircle, Clock } from "lucide-react";

interface Stats {
  totalJobs: number;
  analyzedJobs: number;
  appliedToday: number;
  totalApplications: number;
  scrapedToday?: number;
  fitJobs?: number;
}

interface AutomationState {
  isRunning: boolean;
  startedAt?: string;
  applicationsSubmitted: number;
  jobsScraped: number;
}

export function StatsCards({
  stats,
  automationState,
}: {
  stats: Stats;
  automationState: AutomationState;
}) {
  const cards = [
    {
      label: "Scraped Today",
      value: stats.scrapedToday ?? 0,
      icon: Activity,
      color: "text-cyan-400",
      bg: "bg-cyan-400/10",
      ring: "ring-cyan-400/30",
      highlight: true,
    },
    {
      label: "Fit Jobs",
      value: stats.fitJobs ?? 0,
      icon: Target,
      color: "text-emerald-400",
      bg: "bg-emerald-400/10",
      ring: "ring-emerald-400/30",
      highlight: true,
    },
    {
      label: "Applied Today",
      value: stats.appliedToday,
      icon: Calendar,
      color: "text-orange-400",
      bg: "bg-orange-400/10",
      ring: "ring-orange-400/30",
      highlight: true,
    },
    {
      label: "Total Jobs",
      value: stats.totalJobs,
      icon: Briefcase,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
      ring: "",
    },
    {
      label: "Analyzed",
      value: stats.analyzedJobs,
      icon: TrendingUp,
      color: "text-purple-400",
      bg: "bg-purple-400/10",
      ring: "",
    },
    {
      label: "Applications",
      value: stats.totalApplications,
      icon: Send,
      color: "text-green-400",
      bg: "bg-green-400/10",
      ring: "",
    },
    {
      label: "Session Scraped",
      value: automationState.jobsScraped,
      icon: Clock,
      color: "text-indigo-400",
      bg: "bg-indigo-400/10",
      ring: "",
    },
    {
      label: "Session Applied",
      value: automationState.applicationsSubmitted,
      icon: CheckCircle,
      color: "text-pink-400",
      bg: "bg-pink-400/10",
      ring: "",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`bg-gray-900 border border-gray-800 rounded-xl p-3 ${
            card.highlight ? `ring-1 ${card.ring}` : ""
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className={`p-1.5 rounded-lg ${card.bg}`}>
              <card.icon className={`w-3.5 h-3.5 ${card.color}`} />
            </div>
            <div className={`text-xl font-bold ${card.color}`}>{card.value}</div>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">{card.label}</div>
        </div>
      ))}
    </div>
  );
}
