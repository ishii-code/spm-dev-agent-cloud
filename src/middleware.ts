// Edge runtime middleware: /admin/* を ADMIN 限定で保護。
// auth.ts は Prisma/bcrypt を含み Edge で使えないため、jose を直接呼び出す。
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "spm_dev_session";

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(raw);
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
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const loginUrl = new URL("/login", req.url);

  if (!token) return NextResponse.redirect(loginUrl);

  const role = await verifyRole(token);
  if (!role) return NextResponse.redirect(loginUrl);
  if (role !== "ADMIN") {
    return NextResponse.redirect(new URL("/?error=forbidden", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
