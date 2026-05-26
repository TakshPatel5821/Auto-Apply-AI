-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('FOUND', 'ANALYZED', 'TAILORING', 'TAILORED', 'APPLYING', 'APPLIED', 'INTERVIEWING', 'OFFERED', 'REJECTED', 'WITHDRAWN', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'IN_PROGRESS', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'REJECTED', 'INTERVIEW_SCHEDULED', 'OFFER_RECEIVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "MemoryCategory" AS ENUM ('GENERAL', 'VISA_SPONSORSHIP', 'WORK_AUTHORIZATION', 'SALARY', 'EXPERIENCE', 'RELOCATION', 'DEMOGRAPHICS', 'AVAILABILITY', 'REFERENCES', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'SUCCESS');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "searchKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "searchLocations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
    "requireSponsorship" BOOLEAN NOT NULL DEFAULT false,
    "experienceLevels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minSalary" INTEGER,
    "maxApplicationsPerDay" INTEGER NOT NULL DEFAULT 20,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "blacklistCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredTechStack" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "parsedData" JSONB NOT NULL,
    "skills" TEXT[],
    "experience" JSONB[],
    "education" JSONB[],
    "projects" JSONB[],
    "achievements" TEXT[],
    "technologies" TEXT[],
    "domains" TEXT[],
    "atsKeywords" TEXT[],
    "yearsOfExperience" DOUBLE PRECISION,
    "summary" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TailoredResume" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "latexContent" TEXT NOT NULL,
    "pdfPath" TEXT,
    "texPath" TEXT,
    "overleafUrl" TEXT,
    "tailoringNotes" TEXT,
    "atsScore" DOUBLE PRECISION,
    "keywordsAdded" TEXT[],
    "sectionsModified" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TailoredResume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverLetter" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pdfPath" TEXT,
    "texPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformJobId" TEXT,
    "url" TEXT NOT NULL,
    "applyUrl" TEXT,
    "easyApplyUrl" TEXT,
    "isEasyApply" BOOLEAN NOT NULL DEFAULT false,
    "companyName" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "location" TEXT,
    "salary" TEXT,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "jobType" TEXT,
    "isRemote" BOOLEAN NOT NULL DEFAULT false,
    "isHybrid" BOOLEAN NOT NULL DEFAULT false,
    "requiresSponsorship" BOOLEAN NOT NULL DEFAULT false,
    "experienceLevel" TEXT,
    "description" TEXT NOT NULL,
    "requirements" TEXT[],
    "responsibilities" TEXT[],
    "niceToHave" TEXT[],
    "benefits" TEXT[],
    "matchScore" DOUBLE PRECISION,
    "atsScore" DOUBLE PRECISION,
    "confidenceLevel" DOUBLE PRECISION,
    "requiredSkills" TEXT[],
    "missingSkills" TEXT[],
    "matchingSkills" TEXT[],
    "matchReason" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'FOUND',
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "isSpam" BOOLEAN NOT NULL DEFAULT false,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "resumeId" TEXT,
    "tailoredResumeId" TEXT,
    "coverLetterId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "screenshotPath" TEXT,
    "confirmationId" TEXT,
    "confirmationText" TEXT,
    "answeredQuestions" JSONB[],
    "notes" TEXT,
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "folderPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "questionHash" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "platform" TEXT,
    "category" "MemoryCategory" NOT NULL DEFAULT 'GENERAL',
    "usageCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationLog" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "jobId" TEXT,
    "applicationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapingSession" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "jobsFound" INTEGER NOT NULL DEFAULT 0,
    "jobsNew" INTEGER NOT NULL DEFAULT 0,
    "jobsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ScrapingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE INDEX "Resume_userId_idx" ON "Resume"("userId");

-- CreateIndex
CREATE INDEX "TailoredResume_resumeId_idx" ON "TailoredResume"("resumeId");

-- CreateIndex
CREATE INDEX "TailoredResume_jobId_idx" ON "TailoredResume"("jobId");

-- CreateIndex
CREATE INDEX "CoverLetter_jobId_idx" ON "CoverLetter"("jobId");

-- CreateIndex
CREATE INDEX "Job_companyName_idx" ON "Job"("companyName");

-- CreateIndex
CREATE INDEX "Job_matchScore_idx" ON "Job"("matchScore");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_scrapedAt_idx" ON "Job"("scrapedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_platform_platformJobId_key" ON "Job"("platform", "platformJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_jobId_key" ON "Application"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_tailoredResumeId_key" ON "Application"("tailoredResumeId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_coverLetterId_key" ON "Application"("coverLetterId");

-- CreateIndex
CREATE INDEX "Application_userId_idx" ON "Application"("userId");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");

-- CreateIndex
CREATE INDEX "Application_appliedAt_idx" ON "Application"("appliedAt");

-- CreateIndex
CREATE INDEX "ApplicationMemory_userId_idx" ON "ApplicationMemory"("userId");

-- CreateIndex
CREATE INDEX "ApplicationMemory_questionHash_idx" ON "ApplicationMemory"("questionHash");

-- CreateIndex
CREATE INDEX "ApplicationMemory_category_idx" ON "ApplicationMemory"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationMemory_userId_questionHash_key" ON "ApplicationMemory"("userId", "questionHash");

-- CreateIndex
CREATE INDEX "AutomationLog_level_idx" ON "AutomationLog"("level");

-- CreateIndex
CREATE INDEX "AutomationLog_category_idx" ON "AutomationLog"("category");

-- CreateIndex
CREATE INDEX "AutomationLog_createdAt_idx" ON "AutomationLog"("createdAt");

-- CreateIndex
CREATE INDEX "ScrapingSession_platform_idx" ON "ScrapingSession"("platform");

-- CreateIndex
CREATE INDEX "ScrapingSession_startedAt_idx" ON "ScrapingSession"("startedAt");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resume" ADD CONSTRAINT "Resume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TailoredResume" ADD CONSTRAINT "TailoredResume_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TailoredResume" ADD CONSTRAINT "TailoredResume_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverLetter" ADD CONSTRAINT "CoverLetter_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_tailoredResumeId_fkey" FOREIGN KEY ("tailoredResumeId") REFERENCES "TailoredResume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_coverLetterId_fkey" FOREIGN KEY ("coverLetterId") REFERENCES "CoverLetter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationMemory" ADD CONSTRAINT "ApplicationMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
