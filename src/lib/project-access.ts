// プロジェクト単位の書込/実行認可（Phase2）。共有一覧は維持しつつ、変更・実行は
//   ADMIN = 全許可 ／ 一般 = 自分が owner の案件のみ ／ 他人の owner 付きは 403。
//   owner=null（レガシー/サービス作成）は「認証済みなら許可」＝ロックアウト回避。
// 読取（一覧・閲覧）はこのゲートを通さない（要件B：一般も他人の中身を閲覧可）。
import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { getSession, type SessionPayload } from "./auth";
import { decideProjectAccess } from "./project-access-decision";

export { decideProjectAccess };

export type ProjectAccessResult =
  | { ok: true; session: SessionPayload; ownerId: number | null }
  | { ok: false; response: NextResponse };

export async function requireProjectAccess(projectId: string): Promise<ProjectAccessResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  // ADMIN は project 取得不要で全許可。
  if (session.role === "ADMIN") {
    return { ok: true, session, ownerId: null };
  }
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!proj) {
    return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (decideProjectAccess(session.role, session.userId, proj.ownerId) === "allow") {
    return { ok: true, session, ownerId: proj.ownerId };
  }
  return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
}
