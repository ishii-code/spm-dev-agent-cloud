import { promises as fs } from "node:fs";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type ResetMode = "requirements" | "full";

async function unlinkDocFiles(docs: { obsidianPath: string | null }[]) {
  for (const d of docs) {
    if (d.obsidianPath) {
      await fs.unlink(d.obsidianPath).catch(() => {});
    }
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const mode = obj.mode;
  if (mode !== "requirements" && mode !== "full") {
    return Response.json({ error: "invalid_mode" }, { status: 400 });
  }

  const session = await prisma.session.findUnique({
    where: { id },
    select: { id: true, projectId: true },
  });
  if (!session) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }

  if ((mode as ResetMode) === "requirements") {
    const sprintDocs = await prisma.document.findMany({
      where: { projectId: session.projectId, type: "sprint" },
      select: { id: true, obsidianPath: true },
    });
    await unlinkDocFiles(sprintDocs);
    await prisma.document.deleteMany({
      where: { projectId: session.projectId, type: "sprint" },
    });
    await prisma.session.update({
      where: { id },
      data: { status: "debate" },
    });
    return Response.json({ ok: true, mode });
  }

  // full reset
  const allDocs = await prisma.document.findMany({
    where: { projectId: session.projectId },
    select: { id: true, obsidianPath: true },
  });
  await unlinkDocFiles(allDocs);
  await prisma.$transaction([
    prisma.document.deleteMany({ where: { projectId: session.projectId } }),
    prisma.message.deleteMany({ where: { sessionId: id } }),
    prisma.session.update({
      where: { id },
      data: { status: "initial_interview", debateContext: Prisma.DbNull },
    }),
  ]);

  return Response.json({ ok: true, mode });
}
