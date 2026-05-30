import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Logger } from "@/lib/logging/logger";
import { ensureDir } from "@/lib/storage/file-manager";

const execFileAsync = promisify(execFile);

// Locate the Tectonic binary: explicit env override → the self-contained copy in
// ~/.job-agent-tools → assume it's on PATH.
function findTectonic(): string {
  const fromEnv = process.env.TECTONIC_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(
    homedir(),
    ".job-agent-tools",
    process.platform === "win32" ? "tectonic.exe" : "tectonic"
  );
  if (existsSync(local)) return local;
  return process.platform === "win32" ? "tectonic.exe" : "tectonic";
}

// Compile LaTeX → PDF locally with Tectonic. Deterministic, offline (after the
// one-time package-bundle download), ~3s steady state. Replaces the old Overleaf
// browser automation entirely. Returns the PDF path, or null on failure.
export async function compileLatexToPDF(
  latexContent: string,
  outputDir: string
): Promise<string | null> {
  ensureDir(outputDir);
  const texPath = join(outputDir, "tailored_resume.tex");
  const pdfPath = join(outputDir, "tailored_resume.pdf");

  try {
    writeFileSync(texPath, latexContent, "utf-8");
    const tectonic = findTectonic();
    await Logger.info("PDF", "Compiling résumé PDF locally (Tectonic)...");
    const start = Date.now();

    await execFileAsync(
      tectonic,
      ["-X", "compile", texPath, "--outdir", outputDir, "--keep-logs"],
      { timeout: 180000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
    );

    if (existsSync(pdfPath)) {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      await Logger.success("PDF", `Résumé PDF compiled in ${secs}s → ${pdfPath}`);
      return pdfPath;
    }
    await Logger.warn("PDF", "Tectonic ran but produced no PDF");
    return null;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    // The tail of stderr carries the actual LaTeX error — surface it for debugging.
    const detail = (err.stderr || err.message || String(e)).toString().trim().slice(-600);
    await Logger.error("PDF", `LaTeX compile failed: ${detail}`);
    return null;
  }
}
