// middleware のログイン必須化ロジックの挙動テスト（tsx 実行・デプロイ不要）。
// 実 middleware() を呼び、未ログイン/USER/ADMIN ×（公開/一般/admin）の判定を検証する。
import assert from "node:assert/strict";
process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long-aaaaaa";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
async function tok(role: "ADMIN" | "USER"): Promise<string> {
  return await new SignJWT({ role, userId: 1, email: "x@y.z", name: "x" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);
}
function req(path: string, token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `spm_dev_session=${token}`;
  return new NextRequest(new URL("http://localhost" + path), { headers });
}
async function run(path: string, token?: string) {
  const res = await middleware(req(path, token));
  return { status: res.status, location: res.headers.get("location"), next: res.headers.get("x-middleware-next") };
}

const cases: Array<[string, () => Promise<void>]> = [];
const t = (n: string, f: () => Promise<void>) => cases.push([n, f]);

// 公開：ログアウトでも到達可（リダイレクトも 401 もしない＝next）
t("public /login (no auth) -> pass", async () => { const r = await run("/login"); assert.equal(r.next, "1"); assert.equal(r.location, null); });
t("public /api/health (no auth) -> pass", async () => { const r = await run("/api/health"); assert.equal(r.next, "1"); });
t("public /api/projects seed (no auth) -> pass", async () => { const r = await run("/api/projects"); assert.equal(r.next, "1"); });
t("public /api/auth/login (no auth) -> pass", async () => { const r = await run("/api/auth/login"); assert.equal(r.next, "1"); });
t("public /api/slack/interactions (no auth) -> pass", async () => { const r = await run("/api/slack/interactions"); assert.equal(r.next, "1"); });

// 未ログイン：ページ→/login?next= リダイレクト、API→401
t("page / (no auth) -> redirect /login?next=", async () => {
  const r = await run("/"); assert.equal(r.status, 307);
  assert.ok(r.location && r.location.includes("/login"), r.location ?? "no loc");
  assert.ok(r.location!.includes("next=") && r.location!.includes("%2F"));
});
t("api /api/chat (no auth) -> 401", async () => { const r = await run("/api/chat"); assert.equal(r.status, 401); });
// 公開は /api/projects 完全一致のみ。サブパス /api/projects/[id]* はゲート対象＝401。
t("api /api/projects/:id (no auth) -> 401 (seed base のみ公開)", async () => { const r = await run("/api/projects/abc123"); assert.equal(r.status, 401); });
t("api /api/projects/:id/parts (no auth) -> 401", async () => { const r = await run("/api/projects/abc123/parts"); assert.equal(r.status, 401); });

// ログイン済み非ADMIN(USER)：一般ページ可、/admin はリダイレクト、/api/admin は 403
t("USER /systems -> pass", async () => { const r = await run("/systems", await tok("USER")); assert.equal(r.next, "1"); });
t("USER /admin/users -> redirect /?error=forbidden", async () => {
  const r = await run("/admin/users", await tok("USER")); assert.equal(r.status, 307);
  assert.ok(r.location && r.location.includes("/?error=forbidden"), r.location ?? "no loc");
});
t("USER /api/admin/users -> 403", async () => { const r = await run("/api/admin/users", await tok("USER")); assert.equal(r.status, 403); });

// ADMIN：全可
t("ADMIN /admin/users -> pass", async () => { const r = await run("/admin/users", await tok("ADMIN")); assert.equal(r.next, "1"); });
t("ADMIN /api/admin/users -> pass", async () => { const r = await run("/api/admin/users", await tok("ADMIN")); assert.equal(r.next, "1"); });
t("ADMIN / -> pass", async () => { const r = await run("/", await tok("ADMIN")); assert.equal(r.next, "1"); });

// 無効トークン -> 未ログイン扱い
t("invalid token on page -> redirect /login", async () => {
  const r = await run("/systems", "garbage.token.value"); assert.equal(r.status, 307);
  assert.ok(r.location && r.location.includes("/login"));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of cases) {
    try { await f(); pass++; console.log("  ✓ " + n); }
    catch (e) { fail++; console.error("  ✗ " + n + "\n    " + (e instanceof Error ? e.message : String(e))); }
  }
  console.log(`\n${pass} passed, ${fail} failed (${cases.length} total)`);
  if (fail > 0) process.exit(1);
})();
