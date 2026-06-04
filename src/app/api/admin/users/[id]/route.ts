// DELETE /api/admin/users/[id]: ユーザー削除 (ADMIN 限定、自己削除は禁止)
// PATCH  /api/admin/users/[id]: slackId 設定/編集 (ADMIN 限定)
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiAdmin } from "@/lib/auth";
import { isValidSlackMemberId } from "@/lib/slack-mention";

export const runtime = "nodejs";

export async function PATCH(
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
  let body: { slackId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // slackId: 文字列(U…/W…形式) で設定、null/空で解除。
  if (!("slackId" in body)) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  let slackId: string | null;
  if (body.slackId == null || body.slackId === "") {
    slackId = null;
  } else if (typeof body.slackId === "string" && isValidSlackMemberId(body.slackId.trim())) {
    slackId = body.slackId.trim();
  } else {
    return NextResponse.json({ error: "invalid_slack_id" }, { status: 400 });
  }
  try {
    await prisma.user.update({ where: { id }, data: { slackId } });
  } catch {
    return NextResponse.json({ error: "update_failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, slackId });
}

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
