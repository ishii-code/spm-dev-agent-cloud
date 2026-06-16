import { withMention } from "./slack";
import { pickMentionId } from "./slack-mention";
import { formatJst } from "./time";

// 通知タイトル整形（B2）：登録者名プレフィックス。ownerName=User.name、未設定時は "ごう"。
export function formatProjectLabel(ownerName: string | null | undefined, projectTitle: string): string {
  const name = (ownerName ?? "").trim() || "ごう";
  return `【${name}】${projectTitle}`;
}

// projectId から通知メタ（ラベル用 owner 名 / @mention 用 ID / スレッド ts）を 1 クエリで取得。
//   - ownerName: User.name（未設定・失敗は "ごう"）
//   - mentionId: owner.slackId → creatorSlackId → undefined（呼び出し側で固定 ID にフォールバック）
//     ※ owner.name だけ load して slackId を渡さず固定 U0AMRAQDW65 にフォールバックしていた不具合の修正点。
//   - slackThreadTs: 既存スレッドへの追従用
async function projectNotifyMeta(
  projectId: string,
): Promise<{ ownerName: string; mentionId?: string; slackThreadTs?: string }> {
  try {
    const { prisma } = await import("./prisma");
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        creatorSlackId: true,
        slackThreadTs: true,
        owner: { select: { name: true, slackId: true } },
      },
    });
    return {
      ownerName: p?.owner?.name?.trim() || "ごう",
      mentionId: pickMentionId(p?.owner?.slackId, p?.creatorSlackId),
      slackThreadTs: p?.slackThreadTs ?? undefined,
    };
  } catch {
    return { ownerName: "ごう" };
  }
}

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL ?? "C0B3D1S0LER";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

// Slack メッセージ内の「確認」リンク等の公開ベースURL。
// 既定は Cloud Run の公開URL。APP_BASE_URL env で上書き可能（独自ドメイン移行時など）。
function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL?.trim() ||
    "https://spm-dev-agent-web-842623777962.asia-northeast1.run.app"
  );
}

export {
  waitForSlackApproval,
  waitForSlackChoice,
  postSlackThread,
  waitForReactionApproval,
  checkReactionOnce,
  openDmChannel,
  postSlackTo,
  slackConfigured,
  approvalChannel,
  readUserReplies,
} from "./slack-approval";
export type { SlackApprovalResult } from "./slack-approval";

async function postSlack(text: string, threadTs?: string, mentionId?: string): Promise<string | undefined> {
  if (!SLACK_TOKEN) return undefined;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL,
        text: withMention(text, mentionId),
        thread_ts: threadTs,
      }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch {
    return undefined;
  }
}

async function postSlackBlocks(
  blocks: Record<string, unknown>[],
  fallbackText: string,
  threadTs?: string,
  mentionId?: string
): Promise<string | undefined> {
  if (!SLACK_TOKEN) return undefined;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL,
        text: withMention(fallbackText, mentionId),
        blocks,
        thread_ts: threadTs,
      }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch {
    return undefined;
  }
}

export async function notifyExecutionStart(
  projectId: string,
  projectTitle: string,
  targetRepo: string,
  _startTime: number
): Promise<string | undefined> {
  const { ownerName, mentionId } = await projectNotifyMeta(projectId);
  const ts = await postSlack(
    `🚀 *${formatProjectLabel(ownerName, projectTitle)} 開発開始*\n` +
      `対象: \`${targetRepo}\`\n` +
      `時刻: ${formatJst()}\n` +
      `確認: ${appBaseUrl()}`,
    undefined,
    mentionId,
  );
  if (ts) {
    const { prisma } = await import("./prisma");
    await prisma.project
      .update({
        where: { id: projectId },
        data: { slackThreadTs: ts },
      })
      .catch(() => {});
  }
  return ts;
}

export async function notifyThread(projectId: string, text: string): Promise<void> {
  const { mentionId, slackThreadTs } = await projectNotifyMeta(projectId);
  await postSlack(text, slackThreadTs, mentionId);
}

export async function notifyComplete(
  projectId: string,
  projectTitle: string,
  startTime: number,
  success: boolean
): Promise<void> {
  const sec = Math.round((Date.now() - startTime) / 1000);
  const emoji = success ? "✅" : "❌";
  const label = success ? "実装完了" : "エラーが発生しました";
  const { ownerName } = await projectNotifyMeta(projectId);
  await notifyThread(projectId, `${emoji} *${formatProjectLabel(ownerName, projectTitle)} ${label}*\n所要時間: ${sec}秒`);
}

export async function notifySecurityApproval(
  projectId: string,
  approvalId: string,
  description: string
): Promise<void> {
  const { mentionId, slackThreadTs: threadTs } = await projectNotifyMeta(projectId);

  await postSlackBlocks(
    [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ *セキュリティ確認が必要です*\n内容: ${description}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ 承認", emoji: true },
            style: "primary",
            action_id: "approve_security",
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ 拒否", emoji: true },
            style: "danger",
            action_id: "reject_security",
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "🌐 Webで確認", emoji: true },
            url: `${appBaseUrl()}/approvals/${approvalId}`,
            action_id: "view_security",
          },
        ],
      },
    ],
    `⚠️ セキュリティ確認が必要です: ${description}`,
    threadTs,
    mentionId
  );
}
