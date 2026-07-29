import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "./crypto";

const USER_ID = "local";

export interface Credentials {
  linkedinEmail: string;
  linkedinPassword: string;
  atsEmail: string;
  atsPassword: string;
}

// Resolve a credential: prefer the encrypted DB value, fall back to the
// plaintext .env (legacy) so nothing breaks before the user migrates.
function resolve(enc: string | null | undefined, envVal: string | undefined): string {
  const dec = decryptSecret(enc);
  if (dec) return dec;
  return envVal || "";
}

export async function getCredentials(): Promise<Credentials> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  const linkedinEmail = resolve(s?.encLinkedinEmail, process.env.LINKEDIN_EMAIL);
  const linkedinPassword = resolve(s?.encLinkedinPassword, process.env.LINKEDIN_PASSWORD);
  return {
    linkedinEmail,
    linkedinPassword,
    // ATS falls back to LinkedIn creds (matches prior behavior).
    atsEmail: resolve(s?.encAtsEmail, process.env.ATS_EMAIL) || linkedinEmail,
    atsPassword: resolve(s?.encAtsPassword, process.env.ATS_PASSWORD) || linkedinPassword,
  };
}

// Save credentials encrypted. Empty/undefined values are left unchanged.
export async function saveCredentials(input: Partial<Credentials>): Promise<void> {
  const data: Record<string, string> = {};
  if (input.linkedinEmail) data.encLinkedinEmail = encryptSecret(input.linkedinEmail);
  if (input.linkedinPassword) data.encLinkedinPassword = encryptSecret(input.linkedinPassword);
  if (input.atsEmail) data.encAtsEmail = encryptSecret(input.atsEmail);
  if (input.atsPassword) data.encAtsPassword = encryptSecret(input.atsPassword);
  if (Object.keys(data).length === 0) return;

  await prisma.userSettings.upsert({
    where: { userId: USER_ID },
    update: data,
    create: { userId: USER_ID, ...data },
  });
}

// One-time migration: if .env has plaintext creds and the DB has none, pull them
// into the encrypted store. Safe to call repeatedly (no-op once migrated).
export async function migratePlaintextCredentials(): Promise<boolean> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  const alreadyStored =
    s?.encLinkedinPassword || s?.encAtsPassword || s?.encLinkedinEmail || s?.encAtsEmail;
  if (alreadyStored) return false;

  const fromEnv: Partial<Credentials> = {
    linkedinEmail: process.env.LINKEDIN_EMAIL,
    linkedinPassword: process.env.LINKEDIN_PASSWORD,
    atsEmail: process.env.ATS_EMAIL,
    atsPassword: process.env.ATS_PASSWORD,
  };
  if (!fromEnv.linkedinPassword && !fromEnv.atsPassword) return false;
  await saveCredentials(fromEnv);
  return true;
}

// Whether encrypted creds are present (for UI status, never returns the values).
export async function credentialsStatus(): Promise<{
  linkedin: boolean;
  ats: boolean;
}> {
  const s = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  return {
    linkedin: !!s?.encLinkedinPassword,
    ats: !!s?.encAtsPassword,
  };
}
