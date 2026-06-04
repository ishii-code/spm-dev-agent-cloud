// POST /api/auth/slack-id: ログイン中ユーザが自分の Slack メンバーID を設定/編集（本人のみ）。
// body: { slackId: string|null }（U…/W…形式。null/空で解除）。@ハンドル・表示名は不可。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { isValidSlackMemberId } from "@/lib/slack-mention";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { slackId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  let slackId: string | null;
  if (body.slackId == null || body.slackId === "") {
    slackId = null;
  } else if (typeof body.slackId === "string" && isValidSlackMemberId(body.slackId.trim())) {
    slackId = body.slackId.trim();
  } else {
    return NextResponse.json({ error: "invalid_slack_id" }, { status: 400 });
  }
  await prisma.user.update({ where: { id: session.userId }, data: { slackId } });
  return NextResponse.json({ ok: true, slackId });
}
