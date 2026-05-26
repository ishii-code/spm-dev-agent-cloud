import { prisma } from "@/lib/prisma";
import { fireAndForgetTick } from "@/lib/parallel-tick";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const [documents, project] = await Promise.all([
    prisma.document.findMany({
      where: {
        projectId: id,
        partNumber: { not: null },
      },
      orderBy: { partNumber: "asc" },
      select: {
        partNumber: true,
        partTitle: true,
        executionStatus: true,
      },
    }),
    prisma.project.findUnique({
      where: { id },
      select: { parallelStatus: true },
    }),
  ]);

  // 並列実行が "running" の間は毎ポーリングで tick を発射する。
  // 多重起動は parallel-tick.ts の acquireLock（updateMany WHERE parallelRunId IS NULL）
  // が原子的に弾くため、stuck lock があっても recoverFromCrash で復旧後に自動再開できる。
  if (project?.parallelStatus === "running") {
    fireAndForgetTick(id);
  }

  return Response.json(documents);
}
