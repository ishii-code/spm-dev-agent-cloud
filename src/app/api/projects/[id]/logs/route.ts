import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const MAX_LINES = 200;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  // 実行ログを持つ最新の Document（sprint / sprint_part）を取得し、
  // executionLog を行に分割して直近 200 行を返す。
  const docs = await prisma.document.findMany({
    where: {
      projectId: id,
      executionLog: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: {
      partNumber: true,
      partTitle: true,
      executionLog: true,
      updatedAt: true,
    },
  });

  // 並列実行時は per-part を partNumber 昇順で結合、通常実行は単一 Document
  const ordered = [...docs].sort((a, b) => {
    const ap = a.partNumber ?? 0;
    const bp = b.partNumber ?? 0;
    return ap - bp;
  });

  const lines: string[] = [];
  for (const d of ordered) {
    const log = d.executionLog ?? "";
    if (!log) continue;
    if (d.partNumber) {
      lines.push(`=== Part${d.partNumber}: ${d.partTitle ?? ""} ===`);
    }
    for (const raw of log.split(/\r?\n/)) {
      if (raw.length > 0) lines.push(raw);
    }
  }

  return Response.json(lines.slice(-MAX_LINES));
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  await prisma.document.updateMany({
    where: {
      projectId: id,
      executionLog: { not: null },
    },
    data: { executionLog: null },
  });
  return Response.json({ ok: true });
}
