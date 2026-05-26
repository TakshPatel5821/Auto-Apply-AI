import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/prisma";
import { ExcelJobRow } from "@/types";

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
    { header: "Company Name", key: "companyName", width: 25 },
    { header: "Job Title", key: "jobTitle", width: 30 },
    { header: "Location", key: "location", width: 20 },
    { header: "Salary", key: "salary", width: 20 },
    { header: "Job Type", key: "jobType", width: 15 },
    { header: "Match Score (1=best)", key: "matchScore", width: 18 },
    { header: "ATS Score", key: "atsScore", width: 12 },
    { header: "Required Skills", key: "requiredSkills", width: 40 },
    { header: "Missing Skills", key: "missingSkills", width: 40 },
    { header: "Easy Apply", key: "easyApplyAvailable", width: 12 },
    { header: "Apply Link", key: "directApplyLink", width: 50 },
    { header: "Platform", key: "platform", width: 15 },
    { header: "Resume Path", key: "resumeVersionPath", width: 50 },
    { header: "Cover Letter Path", key: "coverLetterPath", width: 50 },
    { header: "Application Status", key: "applicationStatus", width: 20 },
    { header: "Date Found", key: "dateFound", width: 15 },
    { header: "Date Applied", key: "dateApplied", width: 15 },
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
    const row: ExcelJobRow = {
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      location: job.location || "N/A",
      salary: job.salary || "Not specified",
      jobType: job.jobType || "N/A",
      matchScore: job.matchScore || 0,
      atsScore: job.atsScore || 0,
      requiredSkills: (job.requiredSkills || []).join(", "),
      missingSkills: (job.missingSkills || []).join(", "),
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

    // Color coding by match score
    const score = job.matchScore || 10;
    let fillColor = "FFFFFFFF";
    if (score <= 3) fillColor = "FFD1FAE5"; // green - excellent
    else if (score <= 5) fillColor = "FFFEF9C3"; // yellow - good
    else if (score <= 7) fillColor = "FFFED7AA"; // orange - fair
    else fillColor = "FFFEE2E2"; // red - weak

    dataRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: fillColor },
    };

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

  // Auto-filter
  sheet.autoFilter = {
    from: "A1",
    to: `Q${jobs.length + 1}`,
  };

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
