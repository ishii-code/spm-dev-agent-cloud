// POST /api/admin/users/[id]/reset-password: 仮パスワード再発行 (ADMIN 限定)
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireApiAdmin } from "@/lib/auth";
import { generateTempPassword, tempPasswordExpiry, clientIp } from "@/lib/account-security";
import { recordAuthAudit } from "@/lib/auth-audit";

export const runtime = "nodejs";

export async function POST(
  req: Request,
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
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      mustChangePassword: true,
      tempPasswordExpiresAt: tempPasswordExpiry(),
    },
  });
  await recordAuthAudit("pw_reset", { userId: id, email: user.email, ip: clientIp(req.headers) });
  // 仮PW平文は応答1回のみ返却（ログ/Slack には出さない）。
  return NextResponse.json({ tempPassword });
}
