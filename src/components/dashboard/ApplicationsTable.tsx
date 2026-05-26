"use client";

import { ExternalLink, FileText, FileIcon } from "lucide-react";

interface Application {
  id: string;
  status: string;
  appliedAt: string | null;
  updatedAt: string;
  job: {
    companyName: string;
    jobTitle: string;
    location: string | null;
    platform: string;
    matchScore: number | null;
    url: string;
    applyUrl: string | null;
  };
  tailoredResume: { id: string; atsScore: number | null; pdfPath: string | null } | null;
  coverLetter: { id: string; pdfPath: string | null } | null;
}

const statusColors: Record<string, string> = {
  PENDING: "bg-gray-700 text-gray-300",
  APPROVED: "bg-blue-900 text-blue-300",
  IN_PROGRESS: "bg-yellow-900 text-yellow-300",
  SUBMITTED: "bg-purple-900 text-purple-300",
  CONFIRMED: "bg-green-900 text-green-300",
  FAILED: "bg-red-900 text-red-300",
  REJECTED: "bg-red-900 text-red-400",
  INTERVIEW_SCHEDULED: "bg-emerald-900 text-emerald-300",
  OFFER_RECEIVED: "bg-cyan-900 text-cyan-300",
};

export function ApplicationsTable({
  applications,
  onRefresh,
}: {
  applications: Application[];
  onRefresh: () => void;
}) {
  async function approve(appId: string, jobId: string) {
    await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action: "approve" }),
    });
    onRefresh();
  }

  async function submit(jobId: string) {
    await fetch("/api/applications/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action: "submit" }),
    });
    onRefresh();
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Company</th>
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Role</th>
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Status</th>
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Match</th>
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Applied</th>
            <th className="text-left px-4 py-3 text-gray-400 font-medium">Files</th>
            <th className="text-right px-4 py-3 text-gray-400 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr key={app.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
              <td className="px-4 py-3">
                <div className="font-medium text-white">{app.job.companyName}</div>
                <div className="text-xs text-gray-500 capitalize">{app.job.platform}</div>
              </td>
              <td className="px-4 py-3 text-gray-300">{app.job.jobTitle}</td>
              <td className="px-4 py-3">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[app.status] || "bg-gray-700 text-gray-400"}`}>
                  {app.status}
                </span>
              </td>
              <td className="px-4 py-3">
                <span className="text-sm font-bold text-white">
                  {app.job.matchScore?.toFixed(1) || "—"}
                </span>
                {app.tailoredResume?.atsScore && (
                  <div className="text-xs text-gray-500">ATS:{app.tailoredResume.atsScore.toFixed(0)}</div>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">
                {app.appliedAt
                  ? new Date(app.appliedAt).toLocaleDateString()
                  : "Pending"}
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  {app.tailoredResume && (
                    <span title="Resume tailored" className="text-purple-400">
                      <FileText className="w-3.5 h-3.5" />
                    </span>
                  )}
                  {app.coverLetter && (
                    <span title="Cover letter generated" className="text-blue-400">
                      <FileIcon className="w-3.5 h-3.5" />
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <a
                    href={app.job.applyUrl || app.job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  {app.status === "PENDING" && (
                    <button
                      onClick={() => approve(app.id, app.job.applyUrl || "")}
                      className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                    >
                      Approve
                    </button>
                  )}
                  {app.status === "APPROVED" && (
                    <button
                      onClick={() => submit(app.job.applyUrl || "")}
                      className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                    >
                      Apply
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {applications.length === 0 && (
        <div className="text-center py-12 text-gray-600">No applications yet</div>
      )}
    </div>
  );
}
