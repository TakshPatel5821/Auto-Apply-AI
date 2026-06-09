import { compileLatexToPDF, pdfPageCount } from "@/lib/automation/latex-compiler";

// Save .tex only and skip the local PDF compile (e.g. on a machine without the
// LaTeX engine). Legacy SKIP_OVERLEAF is still honored.
const SKIP_PDF = process.env.SKIP_PDF === "true" || process.env.SKIP_OVERLEAF === "true";

// Compile résumé + cover letter to PDF (Tectonic). The résumé keeps the one-page
// guarantee: if the reordered version spills to 2 pages, fall back to the
// canonical content and recompile. Returns the résumé .tex that actually shipped
// so persistence stores the one that matches the PDF.
export async function compileBoth(
  resumeTex: string,
  canonicalResumeTex: string,
  letterTex: string,
  folderPath: string
): Promise<{ resumePdf: string | null; letterPdf: string | null; resumeTexUsed: string }> {
  if (SKIP_PDF) {
    return { resumePdf: null, letterPdf: null, resumeTexUsed: resumeTex };
  }

  let resumeTexUsed = resumeTex;
  let resumePdf = await compileLatexToPDF(resumeTex, folderPath, "resume").catch(() => null);
  if (resumePdf) {
    const pages = pdfPageCount(folderPath, "resume");
    if (pages && pages > 1) {
      resumeTexUsed = canonicalResumeTex;
      resumePdf = await compileLatexToPDF(canonicalResumeTex, folderPath, "resume").catch(() => null);
    }
  }

  const letterPdf = await compileLatexToPDF(letterTex, folderPath, "cover_letter").catch(() => null);
  return { resumePdf, letterPdf, resumeTexUsed };
}
