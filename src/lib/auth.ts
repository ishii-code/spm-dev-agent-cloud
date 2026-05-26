// 認証セッションユーティリティ。
// JWT を httpOnly session cookie (Max-Age 無し = ブラウザ閉じで消去) に保存。
// JWT payload: { userId, email, role, name, mustChangePassword }。exp は 12h の安全網。
// middleware.ts は Edge runtime のためここを import できない(Prisma/bcrypt)。
// middleware は verifySessionToken 相当を自前で jose 呼び出し。

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "spm_dev_session";
const JWT_MAX_AGE_SECONDS = 60 * 60 * 12; // 12h 安全網

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(raw);
}

export type SessionPayload = {
  userId: number;
  email: string;
  role: "ADMIN" | "USER";
  name: string;
  mustChangePassword: boolean;
};

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + JWT_MAX_AGE_SECONDS)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const { userId, email, role, name, mustChangePassword } = payload as unknown as SessionPayload;
    if (typeof userId !== "number" || !email || !role || !name) return null;
    return { userId, email, role, name, mustChangePassword: Boolean(mustChangePassword) };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return await verifySessionToken(token);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function requireAuth(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/?error=forbidden");
  return session;
}

type ApiAuthResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

export async function requireApiAuth(): Promise<ApiAuthResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

export async function requireApiAdmin(): Promise<ApiAuthResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  if (session.role !== "ADMIN") {
    return {
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, session };
}
