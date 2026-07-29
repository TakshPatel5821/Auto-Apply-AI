"use client";

import { useEffect, useState, useCallback } from "react";
import { X, Loader2, RefreshCw, Code, MessageSquare, Building2, HelpCircle, ListChecks } from "lucide-react";

interface InterviewPrep {
  technicalQuestions: { question: string; guidance: string }[];
  behavioralQuestions: { question: string; star: string }[];
  systemDesignQuestions?: { question: string; guidance: string }[];
  companyTalkingPoints: string[];
  questionsToAsk: string[];
  prepTips: string[];
}

export function InterviewPrepModal({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose: () => void;
}) {
  const [prep, setPrep] = useState<InterviewPrep | null>(null);
  const [meta, setMeta] = useState<{ jobTitle: string; companyName: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/interview-prep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Generation failed");
      else {
        setPrep(data.prep);
        setMeta({ jobTitle: data.jobTitle, companyName: data.companyName });
      }
    } catch {
      setError("Request failed");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    generate();
  }, [generate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="card-glass w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-gray-800">
          <div>
            <h3 className="text-white font-semibold">
              Interview prep{meta ? ` — ${meta.jobTitle} @ ${meta.companyName}` : ""}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">AI-generated from this job and your active résumé</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={generate}
              disabled={loading}
              className="p-1.5 text-gray-500 hover:text-white transition-colors disabled:opacity-50"
              title="Regenerate"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-white transition-colors" title="Close (Esc)">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Generating interview prep… (this takes ~20-40s)
            </div>
          ) : error ? (
            <div className="text-center py-16 text-red-400">{error}</div>
          ) : prep ? (
            <div className="space-y-6">
              <Section icon={Code} title="Technical questions" color="text-blue-400">
                {prep.technicalQuestions.map((q, i) => (
                  <div key={i} className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-sm text-white font-medium">{q.question}</div>
                    <div className="text-sm text-gray-400 mt-1">{q.guidance}</div>
                  </div>
                ))}
              </Section>

              <Section icon={MessageSquare} title="Behavioral questions (STAR)" color="text-purple-400">
                {prep.behavioralQuestions.map((q, i) => (
                  <div key={i} className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-sm text-white font-medium">{q.question}</div>
                    <div className="text-sm text-gray-400 mt-1 whitespace-pre-line">{q.star}</div>
                  </div>
                ))}
              </Section>

              {prep.systemDesignQuestions && prep.systemDesignQuestions.length > 0 && (
                <Section icon={MessageSquare} title="System design questions" color="text-orange-400">
                  {prep.systemDesignQuestions.map((q, i) => (
                    <div key={i} className="bg-gray-800/50 rounded-lg p-3">
                      <div className="text-sm text-white font-medium">{q.question}</div>
                      <div className="text-sm text-gray-400 mt-1">{q.guidance}</div>
                    </div>
                  ))}
                </Section>
              )}

              <Section icon={Building2} title="Why you fit" color="text-emerald-400">
                <BulletList items={prep.companyTalkingPoints} />
              </Section>

              <Section icon={HelpCircle} title="Questions to ask them" color="text-cyan-400">
                <BulletList items={prep.questionsToAsk} />
              </Section>

              <Section icon={ListChecks} title="Prep checklist" color="text-amber-400">
                <BulletList items={prep.prepTips} />
              </Section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  color,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={`flex items-center gap-2 mb-2 ${color}`}>
        <Icon className="w-4 h-4" />
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="text-sm text-gray-300 flex gap-2">
          <span className="text-gray-600 mt-0.5">•</span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}
