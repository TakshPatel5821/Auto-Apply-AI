import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/prisma";
import { ExcelJobRow } from "@/types";

// "Is Fit" decision: a job is considered a fit if its matchScore is in the good range.
// matchScore is 1 (best) to 10 (worst). <=6 = fit (good or workable match).
// Unanalyzed jobs (no matchScore) default to "Pending".
function computeFitLabel(matchScore: number | null | undefined, status: string): string {
  if (matchScore == null) return status === "FOUND" ? "Pending" : "Unknown";
  return matchScore <= 6 ? "Yes" : "No";
}

export async function generateJobsExcel(): Promise<Buffer> {
  const jobs = await prisma.job.findMany({
    orderBy: [{ matchScore: "asc" }, { scrapedAt: "desc" }],
    include: {
      application: {
        select: {
          status: true,
          appliedAt: true,
          tailoredResume: { select: { texPath: true, pdfPath: true } },
          coverLetter: { select: { texPath: true, pdfPath: true } },
        },
      },
    },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Job Agent";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Job Applications", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Company", key: "companyName", width: 25 },
    { header: "Job Title", key: "jobTitle", width: 30 },
    { header: "Location", key: "location", width: 20 },
    { header: "Salary", key: "salary", width: 18 },
    { header: "Type", key: "jobType", width: 12 },
    { header: "Fit?", key: "isFit", width: 10 },
    { header: "Match (1=best)", key: "matchScore", width: 14 },
    { header: "ATS", key: "atsScore", width: 8 },
    { header: "Match Reason", key: "matchReason", width: 40 },
    { header: "Required Skills", key: "requiredSkills", width: 35 },
    { header: "Missing Skills", key: "missingSkills", width: 35 },
    { header: "Easy Apply", key: "easyApplyAvailable", width: 12 },
    { header: "Apply Link", key: "directApplyLink", width: 30 },
    { header: "Platform", key: "platform", width: 12 },
    { header: "Resume Path", key: "resumeVersionPath", width: 40 },
    { header: "Cover Letter", key: "coverLetterPath", width: 40 },
    { header: "Status", key: "applicationStatus", width: 18 },
    { header: "Date Found", key: "dateFound", width: 14 },
    { header: "Date Applied", key: "dateApplied", width: 14 },
  ];

  // Header styling
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.height = 25;

  for (const job of jobs) {
    const fitLabel = computeFitLabel(job.matchScore, job.status);

    const row: ExcelJobRow = {
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      location: job.location || "N/A",
      salary: job.salary || "Not specified",
      jobType: job.jobType || "N/A",
      isFit: fitLabel,
      matchScore: job.matchScore || 0,
      atsScore: job.atsScore || 0,
      requiredSkills: (job.requiredSkills || []).join(", "),
      missingSkills: (job.missingSkills || []).join(", "),
      matchReason: job.matchReason || "",
      easyApplyAvailable: job.isEasyApply,
      directApplyLink: job.applyUrl || job.url,
      platform: job.platform,
      resumeVersionPath: job.application?.tailoredResume?.pdfPath || "Not tailored",
      coverLetterPath: job.application?.coverLetter?.pdfPath || "Not generated",
      applicationStatus: job.application?.status || job.status,
      dateFound: job.scrapedAt.toLocaleDateString(),
      dateApplied: job.application?.appliedAt
        ? job.application.appliedAt.toLocaleDateString()
        : "Not applied",
    };

    const dataRow = sheet.addRow(row);

    // Row coloring based on fit status (primary) + match score (intensity)
    let fillColor = "FFFFFFFF";
    if (fitLabel === "Yes") {
      const score = job.matchScore || 10;
      if (score <= 3) fillColor = "FFB7F4C9"; // strong green
      else if (score <= 5) fillColor = "FFD1FAE5"; // light green
      else fillColor = "FFFEF9C3"; // yellow (borderline fit)
    } else if (fitLabel === "No") {
      fillColor = "FFFEE2E2"; // light red
    } else {
      fillColor = "FFF3F4F6"; // gray (pending)
    }

    dataRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };

    // Color the Fit cell more emphatically
    const fitCell = dataRow.getCell("isFit");
    fitCell.alignment = { horizontal: "center" };
    fitCell.font = { bold: true };
    if (fitLabel === "Yes") {
      fitCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF10B981" } };
      fitCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    } else if (fitLabel === "No") {
      fitCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEF4444" } };
      fitCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    }

    // Hyperlink for apply link
    const linkCell = dataRow.getCell("directApplyLink");
    if (job.applyUrl || job.url) {
      linkCell.value = {
        text: "Apply Here",
        hyperlink: job.applyUrl || job.url,
      };
      linkCell.font = { color: { argb: "FF2563EB" }, underline: true };
    }
  }

  // Auto-filter on all columns
  if (jobs.length > 0) {
    const lastCol = String.fromCharCode(64 + sheet.columns.length); // A..Z
    sheet.autoFilter = {
      from: "A1",
      to: `${lastCol}${jobs.length + 1}`,
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function generateApplicationsExcel(): Promise<Buffer> {
  const applications = await prisma.application.findMany({
    where: { userId: "local" },
    orderBy: { updatedAt: "desc" },
    include: {
      job: true,
      tailoredResume: { select: { atsScore: true, pdfPath: true } },
      coverLetter: { select: { pdfPath: true } },
    },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Applications");

  sheet.columns = [
    { header: "Company", key: "company", width: 25 },
    { header: "Job Title", key: "title", width: 30 },
    { header: "Status", key: "status", width: 20 },
    { header: "Match Score", key: "matchScore", width: 15 },
    { header: "ATS Score", key: "atsScore", width: 12 },
    { header: "Applied Date", key: "appliedDate", width: 15 },
    { header: "Platform", key: "platform", width: 15 },
    { header: "Resume", key: "resume", width: 40 },
    { header: "Cover Letter", key: "coverLetter", width: 40 },
    { header: "Apply Link", key: "link", width: 50 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };

  for (const app of applications) {
    sheet.addRow({
      company: app.job.companyName,
      title: app.job.jobTitle,
      status: app.status,
      matchScore: app.job.matchScore || "N/A",
      atsScore: app.tailoredResume?.atsScore || "N/A",
      appliedDate: app.appliedAt?.toLocaleDateString() || "Pending",
      platform: app.job.platform,
      resume: app.tailoredResume?.pdfPath || "Not generated",
      coverLetter: app.coverLetter?.pdfPath || "Not generated",
      link: app.job.applyUrl || app.job.url,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
