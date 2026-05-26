// DELETE /api/admin/users/[id]: ユーザー削除 (ADMIN 限定、自己削除は禁止)
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiAdmin } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(
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
  if (id === auth.session.userId) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    return NextResponse.json({ error: "delete_failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
