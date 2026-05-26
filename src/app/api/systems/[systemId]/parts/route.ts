import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function mapStatus(raw: string | null): "waiting" | "executing" | "completed" | "error" {
  if (raw === "executing") return "executing";
  if (raw === "completed") return "completed";
  if (raw === "error") return "error";
  return "waiting";
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ systemId: string }> },
) {
  const { systemId } = await ctx.params;

  const session = await prisma.session.findFirst({
    where: {
      status: "executing",
      project: { targetSystem: systemId },
    },
    select: {
      id: true,
      project: { select: { id: true, title: true, targetSystem: true } },
    },
  });

  if (!session) {
    return Response.json({
      systemId,
      sessionId: null,
      projectId: null,
      projectTitle: null,
      parts: [],
    });
  }

  const parts = await prisma.document.findMany({
    where: {
      projectId: session.project.id,
      partNumber: { not: null },
    },
    orderBy: { partNumber: "asc" },
    select: {
      partNumber: true,
      partTitle: true,
      executionStatus: true,
    },
  });

  return Response.json({
    systemId,
    sessionId: session.id,
    projectId: session.project.id,
    projectTitle: session.project.title,
    parts: parts.map((p) => ({
      partNumber: p.partNumber,
      partTitle: p.partTitle,
      status: mapStatus(p.executionStatus),
    })),
  });
}
