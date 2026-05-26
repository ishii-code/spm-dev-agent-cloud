import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const executingSessions = await prisma.session.findMany({
    where: { status: "executing" },
    select: {
      id: true,
      project: {
        select: {
          id: true,
          title: true,
          targetSystem: true,
          targetLabel: true,
        },
      },
    },
  });

  // 現在進行中のパートを推定: Document.executionStatus='executing' の中で
  // partNumber が最も小さい（=実行中の最古パート）を1件採用
  const result = await Promise.all(
    executingSessions.map(async (s) => {
      const part = await prisma.document.findFirst({
        where: {
          projectId: s.project.id,
          executionStatus: "executing",
          partNumber: { not: null },
        },
        orderBy: { partNumber: "asc" },
        select: { partNumber: true, partTitle: true },
      });
      return {
        sessionId: s.id,
        projectId: s.project.id,
        projectTitle: s.project.title,
        targetSystem: s.project.targetSystem,
        targetLabel: s.project.targetLabel,
        currentPart: part
          ? { partNumber: part.partNumber, partTitle: part.partTitle }
          : null,
      };
    }),
  );

  return Response.json({ executing: result });
}
