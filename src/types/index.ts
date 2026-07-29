export type JobStatus =
  | "FOUND"
  | "ANALYZED"
  | "TAILORING"
  | "TAILORED"
  | "APPLYING"
  | "APPLIED"
  | "INTERVIEWING"
  | "OFFERED"
  | "REJECTED"
  | "WITHDRAWN"
  | "SKIPPED"
  | "FAILED";

export type ApplicationStatus =
  | "PENDING"
  | "APPROVED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "REJECTED"
  | "INTERVIEW_SCHEDULED"
  | "OFFER_RECEIVED"
  | "WITHDRAWN";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "SUCCESS";
export type MemoryCategory =
  | "GENERAL"
  | "VISA_SPONSORSHIP"
  | "WORK_AUTHORIZATION"
  | "SALARY"
  | "EXPERIENCE"
  | "RELOCATION"
  | "DEMOGRAPHICS"
  | "AVAILABILITY"
  | "REFERENCES"
  | "CUSTOM";

export interface ParsedResume {
  rawText: string;
  skills: string[];
  experience: WorkExperience[];
  education: Education[];
  projects: Project[];
  achievements: string[];
  technologies: string[];
  domains: string[];
  atsKeywords: string[];
  yearsOfExperience: number;
  summary: string;
  contactInfo: ContactInfo;
}

export interface ContactInfo {
  name?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location?: string;
}

export interface WorkExperience {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string;
  current?: boolean;
  description: string;
  bullets: string[];
  technologies: string[];
}

export interface Education {
  institution: string;
  degree: string;
  field: string;
  startDate?: string;
  endDate?: string;
  gpa?: string;
  honors?: string[];
  courses?: string[];
}

export interface Project {
  name: string;
  description: string;
  technologies: string[];
  url?: string;
  github?: string;
  bullets: string[];
}

export interface ScrapedJob {
  platform: string;
  platformJobId?: string;
  url: string;
  applyUrl?: string;
  easyApplyUrl?: string;
  isEasyApply: boolean;
  companyName: string;
  jobTitle: string;
  location?: string;
  salary?: string;
  salaryMin?: number;
  salaryMax?: number;
  jobType?: string;
  isRemote: boolean;
  isHybrid: boolean;
  requiresSponsorship: boolean;
  experienceLevel?: string;
  description: string;
  requirements: string[];
  responsibilities: string[];
  niceToHave: string[];
  benefits: string[];
  scrapedAt: Date;
}

export interface JobMatch {
  jobId: string;
  matchScore: number;
  atsScore: number;
  confidenceLevel: number;
  requiredSkills: string[];
  missingSkills: string[];
  matchingSkills: string[];
  matchReason: string;
}

export interface TailoredResumeResult {
  latexContent: string;
  pdfPath?: string;
  texPath?: string;
  atsScore: number;
  keywordsAdded: string[];
  sectionsModified: string[];
  tailoringNotes: string;
}

export interface CoverLetterResult {
  content: string;
  pdfPath?: string;
}

export interface ApplicationAnswer {
  questionText: string;
  questionHash: string;
  answerText: string;
  category: MemoryCategory;
}

export interface AutomationState {
  isRunning: boolean;
  isPaused: boolean;
  mode: "auto" | "manual";
  currentJob?: string;
  currentAction?: string;
  jobsScraped: number;
  jobsAnalyzed: number;
  applicationsSubmitted: number;
  applicationsToday: number;
  startedAt?: Date;
  lastActivity?: Date;
  waitingForUser?: boolean;
  waitingReason?: string;
}

export interface DashboardStats {
  totalJobsFound: number;
  totalApplications: number;
  applicationsToday: number;
  interviewCallbacks: number;
  averageMatchScore: number;
  topPlatforms: { platform: string; count: number }[];
  applicationsByStatus: { status: string; count: number }[];
  recentActivity: LogEntry[];
}

export interface LogEntry {
  id: string;
  level: LogLevel;
  category: string;
  message: string;
  details?: Record<string, unknown>;
  jobId?: string;
  applicationId?: string;
  error?: string;
  createdAt: Date;
}

export interface ExcelJobRow {
  companyName: string;
  jobTitle: string;
  location: string;
  salary: string;
  jobType: string;
  isFit: string; // "Yes" or "No"
  matchScore: number;
  atsScore: number;
  requiredSkills: string;
  missingSkills: string;
  matchReason: string;
  easyApplyAvailable: boolean;
  directApplyLink: string;
  platform: string;
  resumeVersionPath: string;
  coverLetterPath: string;
  applicationStatus: string;
  dateFound: string;
  dateApplied: string;
}

export interface SearchConfig {
  keywords: string[];
  locations: string[];
  remote: boolean;
  hybrid: boolean;
  onsite: boolean;
  requireSponsorship: boolean;
  experienceLevels: string[];
  minSalary?: number;
  platforms: string[];
  maxJobs?: number; // Total jobs to scrape across all platforms in one session
}

export interface ScraperOptions {
  maxJobs?: number;
  remote?: boolean;
  experienceLevels?: string[];
  onJob?: (job: ScrapedJob) => Promise<void>;
}

// Visual selector-picker config: CSS selectors the user points at (or that
// suggestCustomSelectors heuristically generates) so a custom site can be
// scraped without code. All optional — the scraper falls back to its built-in
// selector chain for anything left unset.
export interface CustomSiteSelectors {
  card?: string;      // each job card/row
  title?: string;     // job title within a card
  company?: string;   // company within a card
  location?: string;  // location within a card
  link?: string;      // the job-detail anchor within a card
  nextPage?: string;  // pagination "next" control
}

export interface CustomSite {
  id: string;
  name: string;
  url: string;
  email: string;
  password: string;
  jobsUrl?: string;
  enabled: boolean;
  selectors?: CustomSiteSelectors;
}

export interface ScraperConfig {
  delayMin: number;
  delayMax: number;
  maxRetries: number;
  headless: boolean;
  userAgent?: string;
}

export interface FormField {
  type: "text" | "email" | "phone" | "select" | "radio" | "checkbox" | "file" | "textarea" | "date";
  label: string;
  name?: string;
  required: boolean;
  options?: string[];
  value?: string;
  selector?: string;
}

export interface ApplicationSession {
  jobId: string;
  platform: string;
  url: string;
  status: "starting" | "filling" | "uploading" | "submitting" | "completed" | "failed";
  currentStep: string;
  answeredFields: ApplicationAnswer[];
  screenshots: string[];
  startedAt: Date;
}
