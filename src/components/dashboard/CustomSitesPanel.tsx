"use client";

import { useState, useEffect, useCallback } from "react";
import { Globe, Plus, Trash2, ToggleLeft, ToggleRight, Eye, EyeOff, ExternalLink } from "lucide-react";

interface CustomSite {
  id: string;
  name: string;
  url: string;
  email: string;
  password: string;
  jobsUrl?: string;
  enabled: boolean;
}

export function CustomSitesPanel() {
  const [sites, setSites] = useState<CustomSite[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState({ name: "", url: "", email: "", password: "", jobsUrl: "" });

  const fetchSites = useCallback(async () => {
    const res = await fetch("/api/settings/sites");
    if (res.ok) {
      const data = await res.json();
      setSites(data.sites || []);
    }
  }, []);

  useEffect(() => { fetchSites(); }, [fetchSites]);

  async function addSite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch("/api/settings/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ name: "", url: "", email: "", password: "", jobsUrl: "" });
    setShowForm(false);
    setSaving(false);
    fetchSites();
  }

  async function toggleSite(id: string, enabled: boolean) {
    await fetch("/api/settings/sites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled: !enabled }),
    });
    fetchSites();
  }

  async function deleteSite(id: string) {
    await fetch("/api/settings/sites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchSites();
  }

  return (
    <div className="card-glass p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-purple-400" />
          <h3 className="text-sm font-semibold text-white">Custom Job Sites</h3>
          {sites.length > 0 && (
            <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded-full">{sites.length}</span>
          )}
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Site
        </button>
      </div>

      {showForm && (
        <form onSubmit={addSite} className="space-y-2 bg-gray-800/60 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-400 mb-2">
            Paste the homepage URL of any job site. The agent will open it, log in, find the jobs page, and scrape listings automatically.
          </div>
          <input
            placeholder="Site name (e.g. Google Careers)"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
          <input
            placeholder="Homepage URL (e.g. https://careers.google.com)"
            required
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Login email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
            <input
              placeholder="Password"
              type="password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
          </div>
          <input
            placeholder="Jobs page URL (optional — leave blank to auto-detect)"
            value={form.jobsUrl}
            onChange={(e) => setForm({ ...form, jobsUrl: e.target.value })}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? "Saving..." : "Add Site"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {sites.length > 0 ? (
        <div className="space-y-2">
          {sites.map((site) => (
            <div
              key={site.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                site.enabled
                  ? "bg-purple-900/10 border-purple-800/50"
                  : "bg-gray-800/50 border-gray-700"
              }`}
            >
              <Globe className={`w-4 h-4 flex-shrink-0 ${site.enabled ? "text-purple-400" : "text-gray-600"}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white font-medium truncate">{site.name}</span>
                  <a
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-600 hover:text-gray-400"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                  <span className="truncate">{site.email}</span>
                  <span>·</span>
                  <button
                    onClick={() => setShowPasswords((p) => ({ ...p, [site.id]: !p[site.id] }))}
                    className="flex items-center gap-0.5 text-gray-600 hover:text-gray-400"
                  >
                    {showPasswords[site.id] ? (
                      <><EyeOff className="w-3 h-3" /><span>{site.password}</span></>
                    ) : (
                      <><Eye className="w-3 h-3" /><span>{"•".repeat(Math.min(site.password.length, 8))}</span></>
                    )}
                  </button>
                </div>
                {site.jobsUrl && (
                  <div className="text-xs text-gray-600 truncate mt-0.5">{site.jobsUrl}</div>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => toggleSite(site.id, site.enabled)}
                  className={`transition-colors ${site.enabled ? "text-purple-400 hover:text-purple-300" : "text-gray-600 hover:text-gray-400"}`}
                  title={site.enabled ? "Disable" : "Enable"}
                >
                  {site.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                </button>
                <button
                  onClick={() => deleteSite(site.id)}
                  className="text-gray-600 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-600 text-center py-3">
          No custom sites yet. Add any job board or company careers page.
        </div>
      )}
    </div>
  );
}
