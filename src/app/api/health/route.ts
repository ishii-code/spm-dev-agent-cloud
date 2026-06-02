import { prisma } from "@/lib/prisma";

// Cloud Run / Cloud Monitoring Uptime Check 用ヘルスチェック。
// 認証不要（middleware の matcher は /admin/:path* のみで本ルートは非ゲート）。
// DB 到達性のみを確認する。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let dbConnected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  const body = {
    status: dbConnected ? "ok" : "degraded",
    db_connected: dbConnected,
    time: new Date().toISOString(),
  };

  return Response.json(body, { status: dbConnected ? 200 : 503 });
}
