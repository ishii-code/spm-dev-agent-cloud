// POST /api/auth/change-password
// body: { currentPassword, newPassword, confirmPassword }
// 現在のパスワード照合 → 新パスワード一致・長さ検証 → bcrypt 更新 + mustChangePassword=false
// 成功時: 新しい claims で JWT 再発行 (mustChangePassword=false を反映)
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSessionToken, getSession, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { currentPassword?: string; newPassword?: string; confirmPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";
  const confirmPassword = body.confirmPassword ?? "";

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "password_too_short" }, { status: 400 });
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: "password_mismatch" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "current_password_wrong" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 10),
      mustChangePassword: false,
    },
  });

  const token = await createSessionToken({
    userId: updated.id,
    email: updated.email,
    role: updated.role,
    name: updated.name,
    mustChangePassword: false,
  });
  await setSessionCookie(token);

  return NextResponse.json({ ok: true });
}
