// Edge runtime middleware: 全ルートをログイン必須化。公開許可リストのみ未ログイン可。
// /admin/* と /api/admin/* は ADMIN 限定（従来仕様を維持）。
// auth.ts は Prisma/bcrypt を含み Edge で使えないため、jose を直接呼び出す。
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "spm_dev_session";

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(raw);
}

// 未ログインでも到達を許可する公開パス（A で確定）。
// - /login                : ログイン画面
// - /api/auth/*           : 認証 API（login は公開、その他はルート内で getSession 自衛）
// - /api/projects         : work-monitor シード投入先（X-Service-Key OR セッションをルート内で自衛）
// - /api/slack/*          : Slack 承認 webhook（X-Slack-Signature 検証）
// - /api/health           : ヘルスチェック（認証不要）
// - /_next/* , /favicon.ico: Next 内部・静的
const PUBLIC_EXACT = new Set<string>(["/login", "/api/health", "/api/projects", "/favicon.ico"]);
const PUBLIC_PREFIX = ["/api/auth/", "/api/slack/", "/_next/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

async function verifyRole(token: string): Promise<"ADMIN" | "USER" | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const role = (payload as { role?: unknown }).role;
    if (role === "ADMIN" || role === "USER") return role;
    return null;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // 公開パスは素通り（ルート側が必要に応じて自衛）。
  if (isPublic(pathname)) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const role = token ? await verifyRole(token) : null;

  // 未ログイン/無効セッション：API は 401、ページは /login?next= へ。
  if (!role) {
    if (isApi) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // 管理領域（ページ /admin/* ＋ API /api/admin/*）は ADMIN 限定（従来仕様を維持）。
  const isAdminArea = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  if (isAdminArea && role !== "ADMIN") {
    if (isApi) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/?error=forbidden", req.url));
  }

  return NextResponse.next();
}

export const config = {
  // _next/static, _next/image, favicon.ico を除く全ルートを対象（残りはコード内の公開リストで制御）。
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
