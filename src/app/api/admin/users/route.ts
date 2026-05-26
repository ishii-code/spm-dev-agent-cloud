// GET /api/admin/users: ユーザー一覧 (ADMIN 限定)
// POST /api/admin/users: { email, name, role? } → 仮 PW 自動生成して作成
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireApiAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // 紛らわしい 0/O/1/l/I を除外

function genTempPassword(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PW_CHARS[Math.floor(Math.random() * PW_CHARS.length)];
  }
  return out;
}

export async function GET() {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      lastLoginAt: true,
      mustChangePassword: true,
    },
  });
  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  let body: { email?: unknown; name?: unknown; role?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const emailRaw = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const nameRaw = typeof body.name === "string" ? body.name.trim() : "";
  const role = body.role === "ADMIN" ? "ADMIN" : "USER";

  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (!nameRaw) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }
  if (nameRaw.length > 100 || emailRaw.length > 200) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: emailRaw } });
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const tempPassword = genTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const user = await prisma.user.create({
    data: {
      email: emailRaw,
      name: nameRaw,
      role,
      passwordHash,
      mustChangePassword: true,
    },
    select: { id: true, email: true, name: true, role: true },
  });
  return NextResponse.json({ user, tempPassword });
}
