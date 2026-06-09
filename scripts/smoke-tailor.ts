import { readFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db/prisma";
import { getApplicationFolder } from "@/lib/storage/file-manager";
import { tailorJob } from "@/lib/tailoring";

// Smoke test for the tailoring v3 pipeline.
//   npx tsx scripts/smoke-tailor.ts [jobId]
// With no jobId it picks the most recent FOUND job. Loads the active résumé,
// runs tailorJob, then prints the PDF/.tex paths + the composed summary + letter.
async function main() {
  const jobId = process.argv[2];

  const resume = await prisma.resume.findFirst({
    where: { userId: "local", isActive: true },
    select: { id: true, fileName: true },
  });
  if (!resume) throw new Error("No active résumé found — upload + activate one first.");

  const job = jobId
    ? await prisma.job.findUnique({ where: { id: jobId } })
    : await prisma.job.findFirst({ where: { status: "FOUND" }, orderBy: { scrapedAt: "desc" } });
  if (!job) throw new Error(jobId ? `Job ${jobId} not found` : "No FOUND job in the DB");

  console.log(`\nRésumé: ${resume.fileName} (${resume.id})`);
  console.log(`Job:    ${job.jobTitle} @ ${job.companyName} (${job.id})\n`);

  const { tailoredResumeId, coverLetterId } = await tailorJob(resume.id, job.id);

  const [tr, cl] = await Promise.all([
    prisma.tailoredResume.findUnique({ where: { id: tailoredResumeId } }),
    prisma.coverLetter.findUnique({ where: { id: coverLetterId } }),
  ]);

  let summary = "(unavailable)";
  try {
    const folder = getApplicationFolder(job.companyName, job.jobTitle);
    const meta = JSON.parse(readFileSync(join(folder, "metadata.json"), "utf-8"));
    summary = meta.tailoredSummary || summary;
  } catch { /* ignore */ }

  console.log("Résumé PDF: ", tr?.pdfPath ?? "(none)");
  console.log("Résumé TEX: ", tr?.texPath ?? "(none)");
  console.log("Letter PDF: ", cl?.pdfPath ?? "(none)");
  console.log("Letter TEX: ", cl?.texPath ?? "(none)");
  console.log("ATS score:  ", tr?.atsScore);
  console.log("Keywords:   ", (tr?.keywordsAdded ?? []).join(", "));

  console.log("\n================ SUMMARY ================\n" + summary);
  console.log("\n============== COVER LETTER =============\n" + (cl?.content ?? "(none)") + "\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\nSMOKE FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
