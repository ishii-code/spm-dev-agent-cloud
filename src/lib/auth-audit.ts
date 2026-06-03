// 認証監査ログの書込み（append-only）。パスワード・トークンは保存しない。
// ベストエフォート：監査の失敗は本処理を止めない（catch して握りつぶす）。
import { prisma } from "./prisma";

export type AuthEvent =
  | "login_success"
  | "login_fail"
  | "temp_pw_issued"
  | "pw_reset"
  | "pw_changed"
  | "rate_limited";

export async function recordAuthAudit(
  event: AuthEvent,
  info: { userId?: number | null; email: string; ip?: string | null },
): Promise<void> {
  try {
    await prisma.authAuditLog.create({
      data: {
        event,
        userId: info.userId ?? null,
        email: (info.email ?? "").slice(0, 200),
        ip: info.ip ?? null,
      },
    });
  } catch (e) {
    // 監査は付随処理。失敗してもログイン等の本処理は継続させる。
    console.error("[audit] record failed:", e instanceof Error ? e.message : String(e));
  }
}
