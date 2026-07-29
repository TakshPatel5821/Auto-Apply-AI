"use client";

import { useCallback, useEffect, useState } from "react";
import { Github, Loader2, Check, Pencil, ExternalLink, Star } from "lucide-react";

interface GhProject {
  id: string;
  repo: string;
  name: string;
  bullet: string;
  stack: string[];
  url: string;
  language: string | null;
  stars: number;
  hasReadme: boolean;
  selected: boolean;
}

export function GithubProjectsPanel() {
  const [projects, setProjects] = useState<GhProject[]>([]);
  const [username, setUsername] = useState(process.env.NEXT_PUBLIC_GITHUB_USERNAME || "");
  const [token, setToken] = useState("");
  const [includeForks, setIncludeForks] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/github/projects");
    if (res.ok) setProjects((await res.json()).projects || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function fetchGithub() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/github/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, token: token.trim() || undefined, includeForks }),
      });
      const data = await res.json();
      if (data.projects) {
        setProjects(data.projects);
        const s = data.stats as { fetched: number; forks: number } | undefined;
        const forkNote = s && s.forks ? `, ${s.forks} fork${s.forks === 1 ? "" : "s"} ${includeForks ? "included" : "hidden"}` : "";
        setNotice(
          data.warning ||
            `Imported ${data.count}${s ? ` of ${s.fetched}` : ""} repo${data.count === 1 ? "" : "s"}${forkNote}${
              data.authenticatedAs ? ` — @${data.authenticatedAs}` : " (public only — add a token for private)"
            }.`
        );
      } else setError(data.error || "Fetch failed.");
    } catch {
      setError("Fetch failed — see logs.");
    } finally {
      setLoading(false);
    }
  }

  async function update(id: string, patch: Partial<GhProject>) {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p))); // optimistic
    await fetch("/api/github/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
  }

  const selectedCount = projects.filter((p) => p.selected).length;

  return (
    <div className="card-glass p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Github className="w-5 h-5 text-white" />
          <h3 className="text-sm font-semibold text-white">GitHub Projects</h3>
          <span className="text-xs text-gray-500">{selectedCount} selected → shown on your résumé + cover letter</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="github username"
            className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white w-32 focus:outline-none focus:border-blue-500"
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="token (for private repos)"
            title="A GitHub personal access token with 'repo' scope. Optional — only needed to import PRIVATE repos. Not stored."
            className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white w-44 focus:outline-none focus:border-blue-500"
          />
          <label className="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer whitespace-nowrap" title="Include repos you forked from others">
            <input type="checkbox" checked={includeForks} onChange={(e) => setIncludeForks(e.target.checked)} className="w-3 h-3 accent-emerald-500" />
            forks
          </label>
          <button
            onClick={fetchGithub}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-br from-gray-700 to-gray-800 hover:from-gray-600 hover:to-gray-700 border border-white/10 rounded-lg disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Github className="w-3.5 h-3.5" />}
            {loading ? "Fetching…" : "Fetch from GitHub"}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-600">
        Public repos import without a token. To include <span className="text-gray-400">private</span> repos, paste a GitHub
        token with <span className="text-gray-400">repo</span> scope (github.com → Settings → Developer settings → Tokens). It is used only for this fetch — never stored.
      </p>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {notice && (
        <div className={`text-xs ${/missing|invalid|public only/i.test(notice) ? "text-amber-400" : "text-emerald-400"}`}>{notice}</div>
      )}

      {projects.length === 0 ? (
        <div className="text-xs text-gray-600 py-6 text-center">
          No projects yet — hit &quot;Fetch from GitHub&quot; to import your repos. We clean up the names and pull details from each README.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} onUpdate={update} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p, onUpdate }: { p: GhProject; onUpdate: (id: string, patch: Partial<GhProject>) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [bullet, setBullet] = useState(p.bullet);

  function save() {
    onUpdate(p.id, { name: name.trim() || p.name, bullet: bullet.trim() || p.bullet });
    setEditing(false);
  }

  return (
    <div
      className={`rounded-lg p-3 border transition-colors ${
        p.selected ? "bg-emerald-500/5 border-emerald-500/30" : "bg-gray-800/40 border-white/[0.06]"
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => onUpdate(p.id, { selected: !p.selected })}
          className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
            p.selected ? "bg-emerald-500 border-emerald-500" : "border-gray-600 hover:border-emerald-400"
          }`}
          title={p.selected ? "Shown on your CV — click to remove" : "Click to include on your CV"}
        >
          {p.selected && <Check className="w-3.5 h-3.5 text-white" />}
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-2 py-1 bg-gray-900 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <textarea
                value={bullet}
                onChange={(e) => setBullet(e.target.value)}
                rows={2}
                className="w-full px-2 py-1 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 focus:outline-none focus:border-blue-500 resize-y"
              />
              <div className="flex gap-2">
                <button onClick={save} className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded">Save</button>
                <button
                  onClick={() => { setName(p.name); setBullet(p.bullet); setEditing(false); }}
                  className="text-xs text-gray-500 hover:text-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-white truncate">{p.name}</span>
                <button onClick={() => setEditing(true)} className="text-gray-600 hover:text-blue-400 flex-shrink-0" title="Edit title / description">
                  <Pencil className="w-3 h-3" />
                </button>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-blue-400 flex-shrink-0">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">{p.bullet}</div>
              <div className="flex flex-wrap gap-1 mt-1.5 items-center">
                {p.stack.map((s) => (
                  <span key={s} className="text-[10px] bg-white/5 text-gray-300 px-1.5 py-0.5 rounded">{s}</span>
                ))}
                {p.stars > 0 && (
                  <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
                    <Star className="w-2.5 h-2.5" />
                    {p.stars}
                  </span>
                )}
                {!p.hasReadme && <span className="text-[10px] text-gray-600">no README</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
