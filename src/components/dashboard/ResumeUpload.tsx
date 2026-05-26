"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText, CheckCircle, Star, Trash2 } from "lucide-react";

interface Resume {
  id: string;
  fileName: string;
  fileType: string;
  skills: string[];
  technologies: string[];
  yearsOfExperience: number | null;
  summary: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { tailoredVersions: number };
}

export function ResumeUpload({
  resumes,
  onUpload,
}: {
  resumes: Resume[];
  onUpload: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [setActiveId, setSetActiveId] = useState<string | null>(null);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    setUploading(true);
    setUploadError("");

    const formData = new FormData();
    formData.append("resume", file);
    formData.append("setActive", "true");

    const res = await fetch("/api/resume/upload", {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      onUpload();
    } else {
      const data = await res.json();
      setUploadError(data.error || "Upload failed");
    }
    setUploading(false);
  }, [onUpload]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/msword": [".doc"],
      "application/zip": [".zip"],
      "text/plain": [".tex", ".txt"],
    },
    maxFiles: 1,
    disabled: uploading,
  });

  async function setActive(resumeId: string) {
    setSetActiveId(resumeId);
    await fetch("/api/resume/upload", {
      method: "POST",
      body: (() => {
        const fd = new FormData();
        fd.append("action", "setActive");
        fd.append("resumeId", resumeId);
        return fd;
      })(),
    });
    setSetActiveId(null);
    onUpload();
  }

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-blue-500 bg-blue-500/10"
            : uploading
            ? "border-gray-700 bg-gray-800/50 cursor-not-allowed"
            : "border-gray-700 hover:border-gray-600 bg-gray-800/30"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className={`w-8 h-8 mx-auto mb-3 ${uploading ? "text-gray-600" : "text-gray-400"}`} />
        {uploading ? (
          <div>
            <div className="text-sm text-gray-400">Uploading and parsing resume...</div>
            <div className="mt-2 w-32 h-1 bg-gray-700 rounded-full mx-auto overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse w-3/4" />
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-gray-300 font-medium">
              {isDragActive ? "Drop your resume here" : "Drag & drop or click to upload"}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              PDF, DOCX, DOC, TEX, ZIP (Overleaf export)
            </div>
          </div>
        )}
      </div>

      {uploadError && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
          {uploadError}
        </div>
      )}

      {resumes.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">
            Uploaded Resumes
          </div>
          {resumes.map((resume) => (
            <div
              key={resume.id}
              className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                resume.isActive
                  ? "bg-blue-900/20 border-blue-800"
                  : "bg-gray-800 border-gray-700"
              }`}
            >
              <FileText className={`w-4 h-4 flex-shrink-0 ${resume.isActive ? "text-blue-400" : "text-gray-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium truncate">{resume.fileName}</div>
                <div className="text-xs text-gray-500">
                  {resume.skills.slice(0, 3).join(", ")}
                  {resume.skills.length > 3 && ` +${resume.skills.length - 3} more`}
                  {resume.yearsOfExperience && ` · ${resume.yearsOfExperience}yr exp`}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {resume._count.tailoredVersions > 0 && (
                  <span className="text-xs text-gray-500">{resume._count.tailoredVersions} tailored</span>
                )}
                {resume.isActive ? (
                  <CheckCircle className="w-4 h-4 text-blue-400" />
                ) : (
                  <button
                    onClick={() => setActive(resume.id)}
                    disabled={setActiveId === resume.id}
                    className="p-1 hover:text-yellow-400 text-gray-600 transition-colors"
                    title="Set as active"
                  >
                    <Star className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
