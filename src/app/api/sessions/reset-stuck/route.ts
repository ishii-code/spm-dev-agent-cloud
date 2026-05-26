import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 1日以上更新されていない詰まったセッションを initial_interview に戻す
export async function POST() {
  const cutoff = new Date(Date.now() - ONE_DAY_MS);
  const stuck = await prisma.session.updateMany({
    where: {
      status: { in: ["waiting_parallel_confirm", "debate", "executing"] },
      updatedAt: { lt: cutoff },
    },
    data: { status: "initial_interview" },
  });
  return Response.json({ reset: stuck.count, cutoff: cutoff.toISOString() });
}

// GET でも同じ挙動（ブラウザから叩けるように）
export async function GET() {
  return POST();
}
