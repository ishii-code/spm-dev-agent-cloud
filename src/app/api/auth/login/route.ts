// POST /api/auth/login
// body: { email, password }
// 成功時: 200 { user }, session cookie 発行
// 失敗時: 401 { error: "invalid_credentials" }（ユーザー列挙防止のため汎用文言）
//        429 { error: "too_many_attempts" } + Retry-After（rate-limit）
//        401 { error: "temp_password_expired" }（仮PW期限切れ。※PW照合成功後のみ返す）
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { checkLoginRateLimit, clientIp, isTempPasswordExpired } from "@/lib/account-security";
import { recordAuthAudit } from "@/lib/auth-audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = clientIp(req.headers);

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // rate-limit（bcrypt 前に弾く）。失敗試行は IP 単位でカウント。
  const rl = checkLoginRateLimit(ip);
  if (!rl.allowed) {
    await recordAuthAudit("rate_limited", { email, ip });
    return NextResponse.json(
      { error: "too_many_attempts" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 900) } },
    );
  }

  if (!email || !password) {
    await recordAuthAudit("login_fail", { email, ip });
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await recordAuthAudit("login_fail", { email, ip });
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordAuthAudit("login_fail", { userId: user.id, email, ip });
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  // PW 照合成功後にのみ仮PW期限を判定（列挙にならない）。期限切れはログイン拒否。
  if (isTempPasswordExpired(user)) {
    await recordAuthAudit("login_fail", { userId: user.id, email, ip });
    return NextResponse.json({ error: "temp_password_expired" }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  await recordAuthAudit("login_success", { userId: user.id, email, ip });

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    mustChangePassword: user.mustChangePassword,
  });
  await setSessionCookie(token);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
  });
}
