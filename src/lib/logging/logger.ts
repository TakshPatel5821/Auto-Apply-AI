import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@prisma/client";
import { LogLevel } from "@/types";

export class Logger {
  static async log(
    level: LogLevel,
    category: string,
    message: string,
    details?: Record<string, unknown>,
    jobId?: string,
    applicationId?: string
  ) {
    const prefix = `[${level}][${category}]`;
    if (level === "ERROR") {
      console.error(prefix, message, details || "");
    } else if (level === "WARN") {
      console.warn(prefix, message, details || "");
    } else {
      console.log(prefix, message, details || "");
    }

    try {
      await prisma.automationLog.create({
        data: {
          level,
          category,
          message,
          details: details as Prisma.InputJsonValue | undefined,
          jobId: jobId || null,
          applicationId: applicationId || null,
        },
      });
    } catch {
      // Don't throw if logging fails
    }
  }

  static info(category: string, message: string, details?: Record<string, unknown>, jobId?: string) {
    return Logger.log("INFO", category, message, details, jobId);
  }

  static error(category: string, message: string, details?: Record<string, unknown>, jobId?: string) {
    return Logger.log("ERROR", category, message, details, jobId);
  }

  static warn(category: string, message: string, details?: Record<string, unknown>, jobId?: string) {
    return Logger.log("WARN", category, message, details, jobId);
  }

  static success(category: string, message: string, details?: Record<string, unknown>, jobId?: string) {
    return Logger.log("SUCCESS", category, message, details, jobId);
  }

  static debug(category: string, message: string, details?: Record<string, unknown>) {
    return Logger.log("DEBUG", category, message, details);
  }
}
