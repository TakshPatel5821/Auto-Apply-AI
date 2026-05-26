"use client";

import { Briefcase, Send, TrendingUp, Calendar, Clock, CheckCircle } from "lucide-react";

interface Stats {
  totalJobs: number;
  analyzedJobs: number;
  appliedToday: number;
  totalApplications: number;
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
      label: "Total Jobs Found",
      value: stats.totalJobs,
      icon: Briefcase,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
    },
    {
      label: "Jobs Analyzed",
      value: stats.analyzedJobs,
      icon: TrendingUp,
      color: "text-purple-400",
      bg: "bg-purple-400/10",
    },
    {
      label: "Total Applications",
      value: stats.totalApplications,
      icon: Send,
      color: "text-green-400",
      bg: "bg-green-400/10",
    },
    {
      label: "Applied Today",
      value: stats.appliedToday,
      icon: Calendar,
      color: "text-orange-400",
      bg: "bg-orange-400/10",
    },
    {
      label: "This Session",
      value: automationState.applicationsSubmitted,
      icon: CheckCircle,
      color: "text-emerald-400",
      bg: "bg-emerald-400/10",
    },
    {
      label: "Jobs Scraped",
      value: automationState.jobsScraped,
      icon: Clock,
      color: "text-cyan-400",
      bg: "bg-cyan-400/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-gray-900 border border-gray-800 rounded-xl p-4"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className={`p-2 rounded-lg ${card.bg}`}>
              <card.icon className={`w-4 h-4 ${card.color}`} />
            </div>
          </div>
          <div className="text-2xl font-bold text-white">{card.value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{card.label}</div>
        </div>
      ))}
    </div>
  );
}
