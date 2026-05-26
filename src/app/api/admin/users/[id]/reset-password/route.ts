// POST /api/admin/users/[id]/reset-password: 仮パスワード再発行 (ADMIN 限定)
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireApiAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const PW_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function genTempPassword(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PW_CHARS[Math.floor(Math.random() * PW_CHARS.length)];
  }
  return out;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;
  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const tempPassword = genTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  await prisma.user.update({
    where: { id },
    data: { passwordHash, mustChangePassword: true },
  });
  return NextResponse.json({ tempPassword });
}
