import { prisma } from "@/lib/db/prisma";
import { runScreeningLoop } from "@/lib/ats-screen/screening-loop";

// Drive the closed applicant↔employer-ATS loop on a real job.
//   npx tsx --env-file=.env scripts/screen-loop.ts [jobId]
async function main() {
  const jobId = process.argv[2];
  const resume = await prisma.resume.findFirst({ where: { userId: "local", isActive: true }, select: { id: true } });
  if (!resume) throw new Error("No active résumé.");
  const job = jobId
    ? await prisma.job.findUnique({ where: { id: jobId } })
    : await prisma.job.findFirst({ orderBy: { scrapedAt: "desc" } });
  if (!job) throw new Error("No job found.");

  console.log(`\nEMPLOYER-ATS SCREENING LOOP`);
  console.log(`Job: ${job.jobTitle} @ ${job.companyName} (${job.id})\n`);

  const result = await runScreeningLoop(resume.id, job.id, { maxRounds: 3, withRecruiterNote: true });

  for (const r of result.rounds) {
    const feat = r.featured.length ? `  (featuring: ${r.featured.join(", ")})` : "";
    console.log(`──── Round ${r.round}${feat} ────`);
    for (const c of r.screen.comments) console.log(`   • ${c}`);
    console.log("");
  }

  console.log(`RESULT: ${result.accepted ? "ACCEPTED ✅" : "REJECTED ❌"}  (score ${result.finalScore}%) — ${result.reason}`);
  if (result.accepted) console.log(`Saved → tailoredResume=${result.tailoredResumeId}  coverLetter=${result.coverLetterId}`);
  else if (result.learnList.length) console.log(`Skills to learn to pass this role: ${result.learnList.join(", ")}`);

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error("\nLOOP FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
