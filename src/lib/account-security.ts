// アカウント機能 Phase1 のセキュリティ純粋ロジック（prisma 非依存＝単体テスト可）。
// 監査ログの DB 書込みは ./auth-audit に分離（こちらは crypto / in-memory のみ）。
import crypto from "node:crypto";

// 紛らわしい 0/O/1/l/I を除外した文字種。
const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const TEMP_PASSWORD_LEN = 16;
export const TEMP_PASSWORD_TTL_HOURS = 48;

// CSPRNG・unbiased。crypto.randomInt は暗号論的乱数かつ剰余バイアスなし。
export function generateTempPassword(len: number = TEMP_PASSWORD_LEN): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PW_CHARS[crypto.randomInt(PW_CHARS.length)];
  }
  return out;
}

// 仮PWの有効期限（発行/reset 時に set する値）。
export function tempPasswordExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + TEMP_PASSWORD_TTL_HOURS * 60 * 60 * 1000);
}

// mustChangePassword かつ期限超過なら期限切れ（ログイン拒否対象）。
// 期限が null の場合は「期限なし」とみなして拒否しない（後方互換：既存仮PWユーザ）。
export function isTempPasswordExpired(
  u: { mustChangePassword: boolean; tempPasswordExpiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    u.mustChangePassword &&
    u.tempPasswordExpiresAt != null &&
    now.getTime() > u.tempPasswordExpiresAt.getTime()
  );
}

// ── ログイン rate-limit（v1：in-memory per-IP・インスタンス単位。WM 方式） ──
// 注意：Cloud Run はマルチインスタンス化すると各インスタンス独立。厳密な分散制限が必要に
// なれば Phase で DB ロックアウト（failedLoginCount/lockedUntil）へ移行する。
const WINDOW_MS = 15 * 60 * 1000; // 15分窓
const MAX_ATTEMPTS = 8; // 窓内の許容失敗回数
const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfter?: number } {
  const e = attempts.get(ip);
  if (!e || e.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  e.count++;
  if (e.count > MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

// テスト用：in-memory カウンタをリセット。
export function _resetLoginRateLimit(): void {
  attempts.clear();
}

// X-Forwarded-For の先頭ホップを client IP とみなす（監査・rate-limit 用）。
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "unknown";
}
