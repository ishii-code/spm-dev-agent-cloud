// POST /api/auth/slack-id: ログイン中ユーザが自分の Slack メンバーID を設定/編集（本人のみ）。
// body: { slackId: string|null }（U…/W…形式。null/空で解除）。
// 設定時は users.info で実在ユーザーに解決できる場合のみ保存し、slackIdVerifiedAt を立てる（動作確認）。
// 解決不可（形式不正/missing_scope/user_not_found/fetch_failed）はエラーで返し保存しない。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { resolveSlackUser, makeUsersInfoFetcher, resolveReasonText } from "@/lib/slack-user";

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

  // 解除（null/空）：slackId・検証時刻ともにクリア。
  if (body.slackId == null || body.slackId === "") {
    await prisma.user.update({
      where: { id: session.userId },
      data: { slackId: null, slackIdVerifiedAt: null },
    });
    return NextResponse.json({ ok: true, slackId: null, verified: false });
  }

  if (typeof body.slackId !== "string") {
    return NextResponse.json({ error: "invalid_slack_id" }, { status: 400 });
  }

  // 動作確認：users.info で実在ユーザーに解決できた場合のみ保存。
  const resolution = await resolveSlackUser(body.slackId, makeUsersInfoFetcher(process.env.SLACK_BOT_TOKEN));
  if (!resolution.ok) {
    return NextResponse.json(
      { error: "slack_resolve_failed", reason: resolution.reason, message: resolveReasonText(resolution.reason!) },
      { status: 400 },
    );
  }

  const slackId = body.slackId.trim();
  await prisma.user.update({
    where: { id: session.userId },
    data: { slackId, slackIdVerifiedAt: new Date() },
  });
  return NextResponse.json({ ok: true, slackId, verified: true, displayName: resolution.displayName ?? null });
}
