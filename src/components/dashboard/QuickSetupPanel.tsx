"use client";

import { useEffect, useState } from "react";
import { Target, Briefcase, MapPin, DollarSign, Award, Globe, Save, Check, X } from "lucide-react";

type Level = "intern" | "entry" | "mid" | "senior";

interface QuickPrefs {
  field: string;
  level: Level;
  years: number;
  locations: string[];
  remoteOnly: boolean;
  requireSponsorship: boolean;
  minSalary: string;
  preferredTech: string[];
}

const LEVELS: { id: Level; label: string; years: string }[] = [
  { id: "intern", label: "Intern", years: "Student" },
  { id: "entry", label: "Entry", years: "0-2 yrs" },
  { id: "mid", label: "Mid", years: "3-5 yrs" },
  { id: "senior", label: "Senior", years: "6+ yrs" },
];

// Common job field suggestions
const FIELD_SUGGESTIONS = [
  "Software Engineer",
  "Software Developer",
  "Full Stack Developer",
  "Frontend Developer",
  "Backend Developer",
  "Data Scientist",
  "Data Analyst",
  "Data Engineer",
  "Machine Learning Engineer",
  "DevOps Engineer",
  "Cloud Engineer",
  "Cybersecurity",
  "Security Engineer",
  "Mobile Developer",
  "iOS Developer",
  "Android Developer",
  "Product Manager",
  "QA Engineer",
];

// Build search keywords from field + level
function generateKeywords(field: string, level: Level): string[] {
  const base = field.trim();
  if (!base) return [];

  if (level === "intern") {
    return [
      `${base} Intern`,
      `${base} Internship`,
      base.replace(/Engineer/i, "Engineering Intern"),
    ].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  if (level === "entry") {
    return [
      `Entry Level ${base}`,
      `Junior ${base}`,
      `${base} I`,
      base,
    ].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  if (level === "mid") {
    return [base, `${base} II`, `Mid Level ${base}`].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  // senior
  return [`Senior ${base}`, `${base} III`, `Staff ${base}`, `Lead ${base}`].filter((v, i, a) => v && a.indexOf(v) === i);
}

function levelFromKeywords(keywords: string[]): Level {
  const txt = keywords.join(" ").toLowerCase();
  if (txt.includes("intern")) return "intern";
  if (txt.includes("senior") || txt.includes("staff") || txt.includes("lead")) return "senior";
  if (txt.includes("entry") || txt.includes("junior")) return "entry";
  return "mid";
}

function fieldFromKeywords(keywords: string[]): string {
  const first = keywords[0] || "";
  // Strip level prefixes/suffixes to extract base field
  return first
    .replace(/^(Entry Level |Junior |Senior |Staff |Lead |Mid Level )/i, "")
    .replace(/ (Intern|Internship|I|II|III)$/i, "")
    .replace(/ing Intern$/i, "")
    .trim();
}

export function QuickSetupPanel({ onSave }: { onSave?: () => void }) {
  const [prefs, setPrefs] = useState<QuickPrefs>({
    field: "Software Engineer",
    level: "intern",
    years: 0,
    locations: ["Remote"],
    remoteOnly: true,
    requireSponsorship: false,
    minSalary: "",
    preferredTech: [],
  });

  const [locationInput, setLocationInput] = useState("");
  const [techInput, setTechInput] = useState("");
  const [showFieldSuggestions, setShowFieldSuggestions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  // Load existing settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        const s = data.settings;
        if (s) {
          setPrefs({
            field: fieldFromKeywords(s.searchKeywords || []) || "Software Engineer",
            level: levelFromKeywords(s.searchKeywords || []),
            years: 0,
            locations: s.searchLocations?.length ? s.searchLocations : ["Remote"],
            remoteOnly: s.remoteOnly ?? true,
            requireSponsorship: s.requireSponsorship ?? false,
            minSalary: s.minSalary != null ? String(s.minSalary) : "",
            preferredTech: s.preferredTechStack || [],
          });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const previewKeywords = generateKeywords(prefs.field, prefs.level);

  async function handleSave() {
    setLoading(true);
    setSaved(false);
    const keywords = generateKeywords(prefs.field, prefs.level);

    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchKeywords: keywords,
        searchLocations: prefs.locations,
        remoteOnly: prefs.remoteOnly,
        requireSponsorship: prefs.requireSponsorship,
        experienceLevels: [prefs.level],
        preferredTechStack: prefs.preferredTech,
        minSalary: prefs.minSalary ? parseInt(prefs.minSalary) || null : null,
      }),
    });

    setLoading(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onSave?.();
  }

  function addLocation() {
    const v = locationInput.trim();
    if (v && !prefs.locations.includes(v)) {
      setPrefs({ ...prefs, locations: [...prefs.locations, v] });
      setLocationInput("");
    }
  }

  function removeLocation(loc: string) {
    setPrefs({ ...prefs, locations: prefs.locations.filter((l) => l !== loc) });
  }

  function addTech() {
    const v = techInput.trim();
    if (v && !prefs.preferredTech.includes(v)) {
      setPrefs({ ...prefs, preferredTech: [...prefs.preferredTech, v] });
      setTechInput("");
    }
  }

  function removeTech(t: string) {
    setPrefs({ ...prefs, preferredTech: prefs.preferredTech.filter((x) => x !== t) });
  }

  const filteredSuggestions = prefs.field
    ? FIELD_SUGGESTIONS.filter((s) =>
        s.toLowerCase().includes(prefs.field.toLowerCase()) && s.toLowerCase() !== prefs.field.toLowerCase()
      ).slice(0, 5)
    : FIELD_SUGGESTIONS.slice(0, 5);

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-900/50 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-blue-500/20 rounded-lg">
          <Target className="w-4 h-4 text-blue-400" />
        </div>
        <h3 className="text-sm font-semibold text-white">Quick Job Profile</h3>
        {saved && (
          <span className="ml-auto text-xs text-green-400 flex items-center gap-1">
            <Check className="w-3 h-3" /> Saved
          </span>
        )}
      </div>

      {/* Field */}
      <div className="relative">
        <label className="text-xs text-gray-400 flex items-center gap-1.5 mb-1.5">
          <Briefcase className="w-3 h-3" />
          What kind of role?
        </label>
        <input
          type="text"
          value={prefs.field}
          onChange={(e) => setPrefs({ ...prefs, field: e.target.value })}
          onFocus={() => setShowFieldSuggestions(true)}
          onBlur={() => setTimeout(() => setShowFieldSuggestions(false), 150)}
          placeholder="e.g. Software Engineer"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        {showFieldSuggestions && filteredSuggestions.length > 0 && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden shadow-xl">
            {filteredSuggestions.map((s) => (
              <button
                key={s}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPrefs({ ...prefs, field: s });
                  setShowFieldSuggestions(false);
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Level */}
      <div>
        <label className="text-xs text-gray-400 flex items-center gap-1.5 mb-1.5">
          <Award className="w-3 h-3" />
          Experience Level
        </label>
        <div className="grid grid-cols-4 gap-1.5">
          {LEVELS.map((lvl) => (
            <button
              key={lvl.id}
              type="button"
              onClick={() => setPrefs({ ...prefs, level: lvl.id })}
              className={`py-2 rounded-lg text-xs font-medium border transition-all ${
                prefs.level === lvl.id
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
              }`}
            >
              <div>{lvl.label}</div>
              <div className="text-[10px] opacity-70 mt-0.5">{lvl.years}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Auto-generated keyword preview */}
      {previewKeywords.length > 0 && (
        <div className="bg-gray-800/50 border border-gray-800 rounded-lg p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Will search for
          </div>
          <div className="flex flex-wrap gap-1">
            {previewKeywords.map((kw) => (
              <span key={kw} className="text-[11px] bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded">
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Locations */}
      <div>
        <label className="text-xs text-gray-400 flex items-center gap-1.5 mb-1.5">
          <MapPin className="w-3 h-3" />
          Locations
        </label>
        <div className="flex gap-1.5 mb-1.5">
          <input
            type="text"
            value={locationInput}
            onChange={(e) => setLocationInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLocation();
              }
            }}
            placeholder="Add location, press Enter"
            className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={addLocation}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm"
          >
            +
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {prefs.locations.map((loc) => (
            <span key={loc} className="text-xs bg-gray-800 text-gray-300 pl-2 pr-1 py-0.5 rounded flex items-center gap-1 border border-gray-700">
              {loc}
              <button onClick={() => removeLocation(loc)} className="hover:text-red-400">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Preferred Tech */}
      <div>
        <label className="text-xs text-gray-400 flex items-center gap-1.5 mb-1.5">
          <Globe className="w-3 h-3" />
          Preferred Tech (boosts matching)
        </label>
        <div className="flex gap-1.5 mb-1.5">
          <input
            type="text"
            value={techInput}
            onChange={(e) => setTechInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTech();
              }
            }}
            placeholder="e.g. React, Python..."
            className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={addTech}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm"
          >
            +
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {prefs.preferredTech.map((t) => (
            <span key={t} className="text-xs bg-purple-500/15 text-purple-300 pl-2 pr-1 py-0.5 rounded flex items-center gap-1 border border-purple-500/20">
              {t}
              <button onClick={() => removeTech(t)} className="hover:text-red-400">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Salary + toggles */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 flex items-center gap-1.5 mb-1.5">
            <DollarSign className="w-3 h-3" />
            Min Salary
          </label>
          <input
            type="number"
            value={prefs.minSalary}
            onChange={(e) => setPrefs({ ...prefs, minSalary: e.target.value })}
            placeholder="60000"
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.remoteOnly}
              onChange={(e) => setPrefs({ ...prefs, remoteOnly: e.target.checked })}
              className="w-3.5 h-3.5 accent-blue-500"
            />
            <span className="text-xs text-gray-300">Remote OK</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.requireSponsorship}
              onChange={(e) => setPrefs({ ...prefs, requireSponsorship: e.target.checked })}
              className="w-3.5 h-3.5 accent-blue-500"
            />
            <span className="text-xs text-gray-300">Need visa</span>
          </label>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={loading || !prefs.field.trim() || prefs.locations.length === 0}
        className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
      >
        <Save className="w-4 h-4" />
        Save Profile
      </button>
    </div>
  );
}
