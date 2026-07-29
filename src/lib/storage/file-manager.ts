import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const BASE_PATH = process.env.STORAGE_PATH || "./applications";
const RESUMES_PATH = process.env.RESUMES_PATH || "./applications/resumes";
const LOGS_PATH = process.env.LOGS_PATH || "./logs";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function initStorageDirs(): void {
  ensureDir(BASE_PATH);
  ensureDir(RESUMES_PATH);
  ensureDir(LOGS_PATH);
  ensureDir(path.join(BASE_PATH, "cover_letters"));
  ensureDir(path.join(BASE_PATH, "screenshots"));
}

export function getApplicationFolder(
  companyName: string,
  jobTitle: string,
  date?: Date
): string {
  const dateStr = (date || new Date())
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const safeName = `${companyName}_${jobTitle}_${dateStr}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);

  const folderPath = path.join(BASE_PATH, safeName);
  ensureDir(folderPath);
  return folderPath;
}

export function saveUploadedResume(
  buffer: Buffer,
  originalName: string
): { filePath: string; fileName: string } {
  ensureDir(RESUMES_PATH);
  const ext = path.extname(originalName);
  const fileName = `resume_${uuidv4()}${ext}`;
  const filePath = path.join(RESUMES_PATH, fileName);
  fs.writeFileSync(filePath, buffer);
  return { filePath, fileName };
}

export function saveFile(
  folderPath: string,
  fileName: string,
  content: string | Buffer
): string {
  ensureDir(folderPath);
  const filePath = path.join(folderPath, fileName);
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content);
  } else if (typeof content === "string") {
    fs.writeFileSync(filePath, content, "utf-8");
  } else {
    // Defensive: an unexpected object would otherwise throw ERR_INVALID_ARG_TYPE
    // and abort the whole tailor pipeline. Serialize so the write always succeeds.
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
  }
  return filePath;
}

export function saveApplicationFiles(
  folderPath: string,
  files: {
    resumeTex?: string;
    coverLetterTex?: string;
    jobDescription?: string;
    metadata?: Record<string, unknown>;
  }
): Record<string, string> {
  const paths: Record<string, string> = {};

  if (files.resumeTex) {
    paths.resumeTex = saveFile(folderPath, "resume.tex", files.resumeTex);
  }
  if (files.coverLetterTex) {
    paths.coverLetterTex = saveFile(folderPath, "cover_letter.tex", files.coverLetterTex);
  }
  if (files.jobDescription) {
    paths.jobDescription = saveFile(folderPath, "job_description.txt", files.jobDescription);
  }
  if (files.metadata) {
    paths.metadata = saveFile(
      folderPath,
      "metadata.json",
      JSON.stringify(files.metadata, null, 2)
    );
  }

  return paths;
}

export function savePDF(folderPath: string, fileName: string, pdfBuffer: Buffer): string {
  return saveFile(folderPath, fileName, pdfBuffer);
}

export function saveScreenshot(folderPath: string, screenshot: Buffer, label?: string): string {
  const safeLabel = label ? label.replace(/[^a-z0-9_\-\.]/gi, "_") : "screenshot";
  const fileName = `${safeLabel}_${Date.now()}.png`;
  return saveFile(folderPath, fileName, screenshot);
}

export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function listApplicationFolders(): string[] {
  ensureDir(BASE_PATH);
  return fs
    .readdirSync(BASE_PATH)
    .filter((f) => fs.statSync(path.join(BASE_PATH, f)).isDirectory())
    .map((f) => path.join(BASE_PATH, f));
}

export function getAbsolutePath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.join(process.cwd(), relativePath);
}
