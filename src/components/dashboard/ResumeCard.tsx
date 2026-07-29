"use client";

import { useState } from "react";
import { Pencil, Save, X, Loader2, Trash2 } from "lucide-react";

interface ResumeCardData {
  id: string;
  fileName: string;
  yearsOfExperience: number | null;
  isActive: boolean;
  summary: string | null;
  skills: string[];
  _count?: { tailoredVersions: number };
}

export function ResumeCard({ resume, onSaved }: { resume: ResumeCardData; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const [summary, setSummary] = useState(resume.summary || "");
  const [skills, setSkills] = useState((resume.skills || []).join(", "));
  const [years, setYears] = useState(
    resume.yearsOfExperience != null ? String(resume.yearsOfExperience) : ""
  );

  function reset() {
    setSummary(resume.summary || "");
    setSkills((resume.skills || []).join(", "));
    setYears(resume.yearsOfExperience != null ? String(resume.yearsOfExperience) : "");
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch("/api/resume/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: resume.id,
        summary,
        skills, // comma-separated; the API splits it
        yearsOfExperience: years === "" ? null : Number(years),
      }),
    });
    setSaving(false);
    if (res.ok) {
      setEditing(false);
      onSaved();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Save failed");
    }
  }

  async function remove() {
    if (!confirm(`Delete "${resume.fileName}"? This removes the resume and its tailored versions. This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    setError("");
    const res = await fetch("/api/resume/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: resume.id }),
    });
    setDeleting(false);
    if (res.ok) {
      onSaved();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Delete failed");
    }
  }

  return (
    <div className="card-glass p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="font-medium text-white">{resume.fileName}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {resume.yearsOfExperience?.toFixed(1) || "?"} years experience
            {resume.isActive && <span className="ml-2 text-blue-400">Active</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-600">
            {resume._count?.tailoredVersions || 0} tailored versions
          </div>
          {!editing ? (
            <>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 rounded-lg transition-colors"
                title="Edit summary, skills, and experience"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <button
                onClick={remove}
                disabled={deleting}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-red-600/80 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                title="Delete this resume"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
              </button>
              <button
                onClick={() => { reset(); setEditing(false); }}
                disabled={saving}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-gray-400 rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-red-400 mb-3">{error}</div>}

      {!editing ? (
        <>
          {resume.summary && <p className="text-sm text-gray-400 mb-4 line-clamp-3">{resume.summary}</p>}
          <div className="space-y-2">
            <div className="text-xs text-gray-600 uppercase tracking-wider">Skills</div>
            <div className="flex flex-wrap gap-1">
              {resume.skills.slice(0, 20).map((skill, i) => (
                <span key={`${skill}-${i}`} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                  {skill}
                </span>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 uppercase tracking-wider">Years of experience</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={years}
              onChange={(e) => setYears(e.target.value)}
              className="mt-1 w-32 px-2.5 py-1.5 rounded-lg text-sm bg-white/5 border border-white/10 text-white focus:outline-none focus:border-blue-500/60"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 uppercase tracking-wider">Professional summary</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              className="mt-1 w-full px-2.5 py-1.5 rounded-lg text-sm bg-white/5 border border-white/10 text-white focus:outline-none focus:border-blue-500/60 resize-y"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 uppercase tracking-wider">Skills (comma-separated)</label>
            <textarea
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              rows={3}
              placeholder="Python, React, SQL, …"
              className="mt-1 w-full px-2.5 py-1.5 rounded-lg text-sm bg-white/5 border border-white/10 text-white focus:outline-none focus:border-blue-500/60 resize-y"
            />
          </div>
        </div>
      )}
    </div>
  );
}
