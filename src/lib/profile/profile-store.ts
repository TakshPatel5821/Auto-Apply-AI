import { prisma } from "@/lib/db/prisma";
import { Profile, seedProfileFromResume } from "./profile";

const USER_ID = "local";

// Load the structured profile (from UserSettings.profile JSON).
export async function loadProfile(): Promise<Profile> {
  const settings = await prisma.userSettings.findUnique({ where: { userId: USER_ID } });
  return ((settings?.profile as unknown as Profile) || {}) as Profile;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await prisma.userSettings.upsert({
    where: { userId: USER_ID },
    update: { profile: profile as object },
    create: { userId: USER_ID, profile: profile as object },
  });
}

// Seed/refresh the profile from the active résumé without clobbering locked or
// already-set fields. Safe to call after a résumé upload.
export async function seedProfileFromActiveResume(): Promise<Profile> {
  const resume = await prisma.resume.findFirst({ where: { userId: USER_ID, isActive: true } });
  const existing = await loadProfile();
  if (!resume) return existing;
  const pd = (resume.parsedData as {
    contactInfo?: Record<string, string>;
    education?: unknown[];
    experience?: unknown[];
    skills?: unknown[];
  }) || {};
  const seeded = seedProfileFromResume(existing, {
    contactInfo: pd.contactInfo,
    yearsOfExperience: resume.yearsOfExperience ?? undefined,
    education: pd.education,
    experience: pd.experience,
    skills: pd.skills,
  });
  await saveProfile(seeded);
  return seeded;
}
