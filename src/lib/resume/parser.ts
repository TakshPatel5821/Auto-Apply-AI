import fs from "fs";
import path from "path";
import { claudeParseResume } from "@/lib/ai/claude";
import { ParsedResume } from "@/types";

export async function extractTextFromPDF(filePath: string): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

export async function extractTextFromDOCX(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function extractTextFromTex(filePath: string): Promise<string> {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".pdf":
      return extractTextFromPDF(filePath);
    case ".docx":
    case ".doc":
      return extractTextFromDOCX(filePath);
    case ".tex":
      return extractTextFromTex(filePath);
    case ".txt":
      return fs.readFileSync(filePath, "utf-8");
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

export async function parseResume(filePath: string): Promise<ParsedResume> {
  const text = await extractTextFromFile(filePath);
  const parsed = await claudeParseResume(text) as ParsedResume;
  parsed.rawText = text;
  return parsed;
}

export async function extractLatexFromZip(zipPath: string): Promise<string> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.entryName.endsWith(".tex") && !entry.entryName.includes("/")) {
      return entry.getData().toString("utf-8");
    }
  }

  const texEntry = entries.find((e) => e.entryName.endsWith(".tex"));
  if (texEntry) {
    return texEntry.getData().toString("utf-8");
  }

  throw new Error("No .tex file found in ZIP archive");
}
