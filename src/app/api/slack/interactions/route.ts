import { verifySlackSignature } from "@/lib/slack-verify";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

interface SlackAction {
  action_id: string;
  value: string;
}

interface SlackInteractionPayload {
  type: string;
  response_url: string;
  actions: SlackAction[];
}

async function replaceSlackMessage(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replace_original: true,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    }),
  }).catch(() => {});
}

async function handleApproval(
  approvalId: string,
  status: "approved" | "rejected",
  responseUrl: string
): Promise<void> {
  try {
    const existing = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (existing && existing.status === "pending") {
      await prisma.approvalRequest.update({ where: { id: approvalId }, data: { status } });
    }
    const label = status === "approved" ? "✅ 承認済み" : "❌ 拒否";
    await replaceSlackMessage(responseUrl, `${label}\n承認ID: \`${approvalId}\``);
  } catch {
    // ignore background errors
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payloadStr = new URLSearchParams(rawBody).get("payload");
  if (!payloadStr) {
    return new Response("Bad Request", { status: 400 });
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractionPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const action = payload.actions?.[0];
  if (action && (action.action_id === "approve_security" || action.action_id === "reject_security")) {
    const status = action.action_id === "approve_security" ? "approved" : "rejected";
    // 非同期で処理（Slackの3秒タイムアウト対策）
    void handleApproval(action.value, status, payload.response_url);
  }

  return new Response("OK", { status: 200 });
}
