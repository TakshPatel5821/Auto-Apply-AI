"use client";

import { useEffect, useState, useCallback } from "react";
import { Lock, Unlock, Sparkles, ShieldAlert, Save } from "lucide-react";

interface Spec {
  key: string;
  label: string;
  category: string;
  kind: string;
  compliance: boolean;
}
interface Field {
  value: string;
  locked: boolean;
  confidence: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  identity: "Identity",
  contact: "Contact",
  immigration: "Immigration & Work Authorization",
  education: "Education",
  professional: "Professional",
  preferences: "Preferences (salary, availability, work mode)",
  compliance: "Compliance / EEO (never AI-filled)",
};
const CATEGORY_ORDER = ["identity", "contact", "immigration", "education", "professional", "preferences", "compliance"];

export function ProfilePanel() {
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [profile, setProfile] = useState<Record<string, Field>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/profile");
    if (res.ok) {
      const data = await res.json();
      setSpecs(data.specs || []);
      setProfile(data.profile || {});
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(body: object) {
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      setProfile(data.profile || {});
      setDrafts({});
    }
  }

  const setField = (key: string) => post({ action: "set", key, value: drafts[key] ?? profile[key]?.value ?? "" });
  const toggleLock = (key: string) => post({ action: "lock", key, locked: !profile[key]?.locked });
  const seed = () => post({ action: "seed" });

  if (loading) return <div className="text-center py-12 text-gray-500 text-sm">Loading profile…</div>;

  // Sensitive/compliance fields with no value — these can NEVER be AI-filled, so
  // an empty one means the automation will PAUSE on that question every time.
  const missingSensitive = specs.filter(
    (s) => s.compliance && !(profile[s.key]?.value || "").trim()
  );

  return (
    <div className="space-y-4">
      <div className="card-glass p-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Profile</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            The structured source of truth for form-filling. Locked fields are never changed by AI.
          </p>
        </div>
        <button
          onClick={seed}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 rounded-lg transition-colors"
          title="Fill blanks from your active résumé (won't touch locked fields)"
        >
          <Sparkles className="w-3.5 h-3.5" /> Seed from résumé
        </button>
      </div>

      {missingSensitive.length > 0 && (
        <div className="card-glass p-4 border border-amber-500/30 bg-amber-950/10">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <h4 className="text-sm font-medium text-amber-200">
              {missingSensitive.length} sensitive field{missingSensitive.length > 1 ? "s" : ""} not set
            </h4>
          </div>
          <p className="text-xs text-amber-200/70 mb-2">
            These are legal/EEO/compensation answers AI will never guess. Until you set them,
            the automation pauses for you on every application that asks.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {missingSensitive.map((s) => (
              <span key={s.key} className="px-2 py-0.5 text-[11px] rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-200">
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const catSpecs = specs.filter((s) => s.category === cat);
        if (catSpecs.length === 0) return null;
        return (
          <div key={cat} className="card-glass p-4">
            <div className="flex items-center gap-2 mb-3">
              {cat === "compliance" || cat === "immigration" ? (
                <ShieldAlert className="w-4 h-4 text-amber-400" />
              ) : null}
              <h4 className="text-sm font-medium text-gray-200">{CATEGORY_LABELS[cat]}</h4>
            </div>
            <div className="space-y-2">
              {catSpecs.map((spec) => {
                const f = profile[spec.key];
                const draft = drafts[spec.key] ?? f?.value ?? "";
                const dirty = (drafts[spec.key] ?? f?.value ?? "") !== (f?.value ?? "");
                return (
                  <div key={spec.key} className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 w-44 flex-shrink-0 flex items-center gap-1">
                      {spec.label}
                      {spec.compliance && <span className="text-amber-500" title="Compliance — never AI-filled">*</span>}
                    </label>
                    <input
                      value={draft}
                      disabled={f?.locked}
                      placeholder={spec.kind === "yesno" ? "Yes / No" : "—"}
                      onChange={(e) => setDrafts((d) => ({ ...d, [spec.key]: e.target.value }))}
                      className={`flex-1 px-2.5 py-1.5 rounded-lg text-sm focus:outline-none border transition-colors ${
                        f?.locked
                          ? "bg-blue-950/30 border-blue-500/20 text-blue-200 cursor-not-allowed"
                          : "bg-white/5 border-white/10 text-white focus:border-blue-500/60"
                      }`}
                    />
                    {dirty && !f?.locked && (
                      <button
                        onClick={() => setField(spec.key)}
                        className="p-1.5 text-green-400 hover:text-green-300"
                        title="Save"
                      >
                        <Save className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => toggleLock(spec.key)}
                      disabled={!f?.value}
                      className={`p-1.5 transition-colors disabled:opacity-30 ${
                        f?.locked ? "text-blue-400" : "text-gray-600 hover:text-blue-400"
                      }`}
                      title={f?.locked ? "Unlock" : "Lock (AI can't change)"}
                    >
                      {f?.locked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
