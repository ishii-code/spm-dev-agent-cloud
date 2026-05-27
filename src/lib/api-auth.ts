// 外部サービス（Work Monitor 等）向けの API キー認証ユーティリティ。
// リクエストヘッダー X-Service-Key を環境変数 SERVICE_API_KEY と timing-safe 比較する。

import { NextResponse } from "next/server";

const SERVICE_KEY_HEADER = "x-service-key";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type ServiceAuthResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "invalid_key" | "server_misconfigured" };

/**
 * リクエストの X-Service-Key ヘッダーを SERVICE_API_KEY と比較する。
 * - ヘッダーが無い: missing_header
 * - サーバー側に SERVICE_API_KEY 未設定: server_misconfigured
 * - 不一致: invalid_key
 * - 一致: ok
 */
export function verifyServiceKey(request: Request): ServiceAuthResult {
  const provided = request.headers.get(SERVICE_KEY_HEADER);
  if (!provided) return { ok: false, reason: "missing_header" };

  const expected = process.env.SERVICE_API_KEY;
  if (!expected) {
    console.error("[api-auth] SERVICE_API_KEY is not set");
    return { ok: false, reason: "server_misconfigured" };
  }

  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "invalid_key" };
}

/**
 * X-Service-Key が付与されているか（値の妥当性は問わない）。
 * 外部サービス経由の呼び出しかどうかを判定するのに使う。
 */
export function hasServiceKeyHeader(request: Request): boolean {
  return request.headers.get(SERVICE_KEY_HEADER) !== null;
}

export function serviceAuthErrorResponse(
  reason: "missing_header" | "invalid_key" | "server_misconfigured",
): NextResponse {
  if (reason === "server_misconfigured") {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
