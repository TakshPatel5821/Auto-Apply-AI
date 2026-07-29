import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Create default user
  await prisma.user.upsert({
    where: { id: "local" },
    update: {},
    create: {
      id: "local",
      settings: {
        create: {
          searchKeywords: ["Software Engineer", "Frontend Engineer", "Full Stack Engineer"],
          searchLocations: ["Remote", "New York, NY"],
          remoteOnly: true,
          requireSponsorship: false,
          experienceLevels: ["entry", "mid"],
          maxApplicationsPerDay: 20,
          autoApply: false,
          requireApproval: true,
        },
      },
    },
  });

  // Pre-populate common application memory answers
  const commonAnswers = [
    {
      question: "Are you authorized to work in the United States?",
      answer: "Yes",
      category: "WORK_AUTHORIZATION" as const,
    },
    {
      question: "Do you require visa sponsorship now or in the future?",
      answer: "No",
      category: "VISA_SPONSORSHIP" as const,
    },
    {
      question: "Are you legally authorized to work in the US?",
      answer: "Yes",
      category: "WORK_AUTHORIZATION" as const,
    },
    {
      question: "Will you now or in the future require sponsorship?",
      answer: "No",
      category: "VISA_SPONSORSHIP" as const,
    },
    {
      question: "Are you willing to relocate?",
      answer: "Open to discussion",
      category: "RELOCATION" as const,
    },
    {
      question: "What is your desired salary?",
      answer: "Competitive, based on role and responsibilities",
      category: "SALARY" as const,
    },
    {
      question: "When can you start?",
      answer: "2 weeks notice period",
      category: "AVAILABILITY" as const,
    },
  ];

  const crypto = await import("crypto");

  for (const answer of commonAnswers) {
    const hash = crypto
      .createHash("sha256")
      .update(answer.question.toLowerCase().trim())
      .digest("hex")
      .slice(0, 16);

    await prisma.applicationMemory.upsert({
      where: { userId_questionHash: { userId: "local", questionHash: hash } },
      update: {},
      create: {
        userId: "local",
        questionText: answer.question,
        questionHash: hash,
        answerText: answer.answer,
        category: answer.category,
      },
    });
  }

  console.log("Seed complete");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
