"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Briefcase, Sparkles, FileText, Send, ShieldCheck, Gauge,
  Search, Brain, ArrowRight, Lock,
} from "lucide-react";

const FEATURES = [
  { icon: Search, title: "Scrape & match", desc: "LinkedIn, Indeed & more — scored against your résumé." },
  { icon: FileText, title: "Tailor & compile", desc: "Per-job summary + cover letter, 1-page PDF in seconds." },
  { icon: Send, title: "Auto-apply", desc: "13+ ATS platforms with honest, verified submission." },
  { icon: Brain, title: "Smart memory", desc: "Learns your answers; recognizes the same question reworded." },
];

const PIPELINE = ["Scrape", "Analyze", "Tailor", "Apply", "Track"];

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push("/dashboard");
    } else {
      setError("Invalid password");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.15fr_1fr] relative overflow-hidden">
      {/* Decorative animated orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-24 w-[34rem] h-[34rem] rounded-full bg-blue-600/20 blur-[120px] animate-pulse" />
        <div className="absolute top-1/3 -right-24 w-[30rem] h-[30rem] rounded-full bg-violet-600/20 blur-[120px] animate-pulse" style={{ animationDelay: "1s" }} />
        <div className="absolute -bottom-32 left-1/4 w-[28rem] h-[28rem] rounded-full bg-cyan-500/10 blur-[120px] animate-pulse" style={{ animationDelay: "2s" }} />
      </div>

      {/* ── Left: brand / hero ───────────────────────────────────────────── */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 xl:p-16 border-r border-white/[0.06]">
        <div className="flex items-center gap-2.5 animate-fade-in">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Briefcase className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl text-gradient">AI Job Agent</span>
        </div>

        <div className="max-w-xl animate-fade-in" style={{ animationDelay: "80ms" }}>
          <div className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300 mb-6">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            Apply to jobs on autopilot
          </div>
          <h1 className="text-4xl xl:text-5xl font-bold leading-tight tracking-tight">
            From <span className="text-gradient">job search</span> to{" "}
            <span className="text-gradient">submitted</span> — without the busywork.
          </h1>
          <p className="text-gray-400 mt-5 text-base leading-relaxed">
            Scrapes roles, tailors your résumé and cover letter per job, fills ATS
            forms accurately, and tracks every application through to an offer.
          </p>

          {/* Pipeline strip */}
          <div className="flex items-center gap-2 mt-8 flex-wrap">
            {PIPELINE.map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <span className="text-sm font-medium px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-200">
                  {step}
                </span>
                {i < PIPELINE.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-gray-600" />}
              </div>
            ))}
          </div>

          {/* Feature grid */}
          <div className="grid grid-cols-2 gap-3 mt-10">
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className="card-glass p-4 animate-fade-in"
                style={{ animationDelay: `${160 + i * 60}ms` }}
              >
                <f.icon className="w-5 h-5 text-blue-400 mb-2" />
                <div className="text-sm font-semibold text-white">{f.title}</div>
                <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-gray-600 animate-fade-in" style={{ animationDelay: "120ms" }}>
          <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Encrypted credentials</span>
          <span className="flex items-center gap-1.5"><Gauge className="w-3.5 h-3.5 text-cyan-500" /> Runs locally</span>
          <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5 text-blue-500" /> Your data stays yours</span>
        </div>
      </div>

      {/* ── Right: login ─────────────────────────────────────────────────── */}
      <div className="relative flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm animate-fade-in" style={{ animationDelay: "60ms" }}>
          {/* Mobile brand (hidden on desktop where the hero shows it) */}
          <div className="flex lg:hidden items-center justify-center gap-2.5 mb-8">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
              <Briefcase className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl text-gradient">AI Job Agent</span>
          </div>

          <div className="card-glass rounded-2xl p-8 shadow-2xl">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Welcome back</h2>
              <p className="text-gray-400 text-sm mt-1">Enter your password to open the dashboard.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Access Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoFocus
                    className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/60 focus:border-transparent transition-shadow"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-2.5 rounded-lg animate-fade-in">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="group w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 disabled:opacity-50 text-white font-medium rounded-lg transition-all shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Access Dashboard
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-white/[0.06]">
              <p className="text-center text-xs text-gray-600">
                Private use only · Set <code className="text-gray-500">AUTH_PASSWORD</code> in .env
              </p>
            </div>
          </div>

          <p className="text-center text-xs text-gray-700 mt-6">
            Next.js · Playwright · Claude · PostgreSQL
          </p>
        </div>
      </div>
    </div>
  );
}
