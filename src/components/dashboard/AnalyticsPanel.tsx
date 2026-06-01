"use client";

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { RefreshCw } from "lucide-react";

interface Analytics {
  perDay: { date: string; created: number; applied: number }[];
  platforms: { name: string; value: number }[];
  matchDistribution: { name: string; value: number }[];
  statusFunnel: { name: string; value: number }[];
  summary: {
    totalApplications: number;
    submitted: number;
    interviews: number;
    offers: number;
    avgAts: number;
    interviewRate: number;
    responseRate: number;
    offerRate: number;
  };
}

const PIE_COLORS = ["#3b82f6", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444"];
const tooltipStyle = {
  backgroundColor: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  color: "#e5e7eb",
  fontSize: 12,
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-glass p-4">
      <h3 className="text-sm font-medium text-gray-300 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card-glass p-4">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

export function AnalyticsPanel() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/analytics");
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading analytics…
      </div>
    );
  }
  if (!data) {
    return <div className="text-center py-16 text-gray-600">No analytics available.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <Stat label="Applications" value={data.summary.totalApplications} />
        <Stat label="Submitted" value={data.summary.submitted} />
        <Stat label="Interviews" value={data.summary.interviews} />
        <Stat label="Offers" value={data.summary.offers} />
        <Stat label="Response rate" value={`${data.summary.responseRate}%`} />
        <Stat label="Interview rate" value={`${data.summary.interviewRate}%`} />
        <Stat label="Offer rate" value={`${data.summary.offerRate}%`} />
        <Stat label="Avg ATS" value={`${data.summary.avgAts}/10`} />
      </div>

      {/* Applications per day */}
      <Card title="Applications — last 14 days">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.perDay} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="created" name="Tailored" stroke="#8b5cf6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="applied" name="Applied" stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Match score distribution */}
        <Card title="Match-score distribution (lower = better fit)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.matchDistribution} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" stroke="#6b7280" fontSize={10} interval={0} angle={-12} textAnchor="end" height={50} />
              <YAxis stroke="#6b7280" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#1f293733" }} />
              <Bar dataKey="value" name="Jobs" radius={[4, 4, 0, 0]}>
                {data.matchDistribution.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Platform breakdown */}
        <Card title="Jobs by source">
          {data.platforms.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-gray-600 text-sm">No jobs yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={data.platforms}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={(e) => `${e.name} (${e.value})`}
                  labelLine={false}
                  fontSize={11}
                >
                  {data.platforms.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Status funnel */}
      <Card title="Application status">
        {data.statusFunnel.length === 0 ? (
          <div className="h-[180px] flex items-center justify-center text-gray-600 text-sm">
            No applications yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(160, data.statusFunnel.length * 38)}>
            <BarChart layout="vertical" data={data.statusFunnel} margin={{ top: 5, right: 20, bottom: 0, left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
              <XAxis type="number" stroke="#6b7280" fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke="#6b7280" fontSize={11} width={120} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#1f293733" }} />
              <Bar dataKey="value" name="Applications" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}
