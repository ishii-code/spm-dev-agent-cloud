import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function extractSummary(content: string, max = 200): string {
  const cleaned = content
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + "…";
}

function countSprintsAndTasks(content: string): { sprints: number; tasks: number } {
  const sprintMatches = content.match(/Sprint\s*\d+/gi);
  const sprints = sprintMatches ? new Set(sprintMatches.map((m) => m.toLowerCase())).size : 0;
  const taskMatches = content.match(/^\s*(?:[-*]\s*\[[ xX]\]|[-*]|\d+\.)\s+\S/gm);
  const tasks = taskMatches ? taskMatches.length : 0;
  return { sprints, tasks };
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!project) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }

  const [requirementsDoc, sprintDoc] = await Promise.all([
    prisma.document.findFirst({
      where: { projectId: id, type: "requirements" },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.document.findFirst({
      where: { projectId: id, type: "sprint" },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const requirementsSummary = requirementsDoc
    ? extractSummary(requirementsDoc.content)
    : null;

  const sprintCounts = sprintDoc
    ? countSprintsAndTasks(sprintDoc.content)
    : { sprints: 0, tasks: 0 };

  return Response.json({
    requirementsSummary,
    requirementsFullContent: requirementsDoc?.content ?? null,
    requirementsDocId: requirementsDoc?.id ?? null,
    sprintDocId: sprintDoc?.id ?? null,
    sprintTitle: sprintDoc?.title ?? null,
    sprintCounts,
  });
}
