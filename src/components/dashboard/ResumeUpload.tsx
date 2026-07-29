"use client";

import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText, CheckCircle, Star, Brain, Loader2 } from "lucide-react";

interface Resume {
  id: string;
  fileName: string;
  fileType: string;
  skills: string[];
  technologies: string[];
  yearsOfExperience: number | null;
  summary: string | null;
  isActive: boolean;
  parsedData?: { aiParsed?: boolean };
  createdAt: string;
  _count: { tailoredVersions: number };
}

function AiParseIndicator({ resumeId, onDone }: { resumeId: string; onDone: () => void }) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/resume/status?id=${resumeId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.aiParsed) {
          setDone(true);
          clearInterval(interval);
          onDone();
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [resumeId, onDone]);

  if (done) {
    return <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" />AI parsed</span>;
  }
  return (
    <span className="text-xs text-yellow-400 flex items-center gap-1 animate-pulse">
      <Brain className="w-3 h-3" />AI parsing...
    </span>
  );
}

export function ResumeUpload({ resumes, onUpload }: { resumes: Resume[]; onUpload: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [justUploaded, setJustUploaded] = useState<string | null>(null);

  const onDrop = useCallback(async (files: File[]) => {
    if (!files[0]) return;
    setUploading(true);
    setUploadError("");

    const fd = new FormData();
    fd.append("resume", files[0]);
    fd.append("setActive", "true");

    const res = await fetch("/api/resume/upload", { method: "POST", body: fd });

    if (res.ok) {
      const data = await res.json();
      setJustUploaded(data.resume?.id || null);
      onUpload(); // refresh list immediately — shows quick-extracted data
    } else {
      const data = await res.json().catch(() => ({}));
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

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          isDragActive ? "border-blue-500 bg-blue-500/10"
          : uploading ? "border-gray-700 bg-gray-800/50 cursor-not-allowed"
          : "border-gray-700 hover:border-gray-600 bg-gray-800/30"
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
            <div className="text-sm text-gray-400">Saving resume...</div>
            <div className="text-xs text-gray-600">AI analysis starts in background</div>
          </div>
        ) : (
          <div>
            <Upload className="w-6 h-6 mx-auto mb-2 text-gray-500" />
            <div className="text-sm text-gray-300 font-medium">
              {isDragActive ? "Drop here" : "Drop resume or click to upload"}
            </div>
            <div className="text-xs text-gray-600 mt-1">PDF · DOCX · TEX · ZIP</div>
          </div>
        )}
      </div>

      {uploadError && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
          {uploadError}
        </div>
      )}

      {resumes.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-600 uppercase tracking-wider font-medium">Resumes</div>
          {resumes.map((r) => {
            const isParsing = justUploaded === r.id && !(r.parsedData as { aiParsed?: boolean })?.aiParsed;
            return (
              <div
                key={r.id}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  r.isActive ? "bg-blue-900/20 border-blue-800" : "bg-gray-800 border-gray-700"
                }`}
              >
                <FileText className={`w-4 h-4 flex-shrink-0 ${r.isActive ? "text-blue-400" : "text-gray-500"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium truncate">{r.fileName}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {isParsing
                      ? <AiParseIndicator resumeId={r.id} onDone={onUpload} />
                      : <span className="text-xs text-gray-500">
                          {r.skills.slice(0, 3).join(", ")}{r.skills.length > 3 ? ` +${r.skills.length - 3}` : ""}
                          {r.yearsOfExperience ? ` · ${r.yearsOfExperience}yr` : ""}
                        </span>
                    }
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {r.isActive
                    ? <CheckCircle className="w-4 h-4 text-blue-400" />
                    : <Star className="w-4 h-4 text-gray-600" />
                  }
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
