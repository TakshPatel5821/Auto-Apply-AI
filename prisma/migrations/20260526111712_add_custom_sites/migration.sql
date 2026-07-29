-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "customSites" JSONB NOT NULL DEFAULT '[]';
