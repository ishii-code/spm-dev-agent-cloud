// Slackのリアクションをポーリングして承認可否を取得する。
// 必要なBotスコープ：
//   - chat:write  （承認リクエスト／結果メッセージの送信）
//   - reactions:read（✅/❌ リアクションの取得）
// Slackアプリ設定 > OAuth & Permissions で reactions:read を追加し、
// ワークスペースに再インストールすること。

import { withMention } from "./slack";

const SLACK_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL ?? "C0B3D1S0LER";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const POLL_INTERVAL_MS = 5000;

// Slack Bot トークンが設定済みか。未設定なら承認は自動通過（デッドロック回避）。
export function slackConfigured(): boolean {
  return Boolean(SLACK_TOKEN);
}

// 共有承認チャンネル（DM が使えない場合のフォールバック先）。
export function approvalChannel(): string {
  return SLACK_CHANNEL;
}

// 指定ユーザとの DM チャンネルを開いて channel id（D...）を返す。
// 必要スコープ: im:write。失敗時 undefined。
export async function openDmChannel(slackUserId: string): Promise<string | undefined> {
  if (!SLACK_TOKEN || !slackUserId) return undefined;
  try {
    const res = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({ users: slackUserId }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      channel?: { id?: string };
      error?: string;
    };
    if (!data.ok) {
      console.warn(`[SLACK] conversations.open failed for ${slackUserId}: ${data.error}`);
      return undefined;
    }
    return data.channel?.id;
  } catch (e) {
    console.warn(`[SLACK] conversations.open error for ${slackUserId}: ${e}`);
    return undefined;
  }
}

// 任意のチャンネル（DM or 共有）にメッセージを投稿し ts を返す。失敗時 ""。
export async function postSlackTo(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> {
  const ts = await postMessage(text, threadTs, channel);
  return ts ?? "";
}
const REMINDER_INTERVAL_MS = 3_600_000;

const NUMBER_EMOJI_REVERSE: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

async function postMessage(
  text: string,
  threadTs?: string,
  channel: string = SLACK_CHANNEL,
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
        channel,
        text: withMention(text),
        thread_ts: threadTs,
      }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch {
    return undefined;
  }
}

async function getReactions(
  messageTs: string,
  channel: string = SLACK_CHANNEL,
): Promise<string[]> {
  if (!SLACK_TOKEN) return [];
  try {
    const res = await fetch(
      `https://slack.com/api/reactions.get?channel=${encodeURIComponent(channel)}&timestamp=${encodeURIComponent(messageTs)}`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } },
    );
    const data = (await res.json()) as {
      ok: boolean;
      message?: { reactions?: { name: string }[] };
    };
    if (!data.ok) return [];
    const reactions = data.message?.reactions ?? [];
    return reactions.map((r) => r.name);
  } catch {
    return [];
  }
}

export type SlackApprovalResult = "approved" | "rejected";

// 「いま付いているリアクション」を 1 回だけ取得して判定する非ブロッキング関数。
// ループ・sleep・タイムアウト待ちなし。state machine 用。
//   - ✅（white_check_mark / heavy_check_mark）/ 👍（+1 / thumbsup）→ "approved"
//   - ❌（x / no_entry_sign）→ "rejected"
//   - どちらも無し → "pending"
//   - Slack 未設定 / messageTs 空 → "approved"（デッドロック回避）
// channel は対象メッセージの所属チャンネル（DM=D... または共有チャンネル）。
const APPROVE_REACTIONS = ["white_check_mark", "heavy_check_mark", "+1", "thumbsup"];
const REJECT_REACTIONS = ["x", "no_entry_sign"];

export async function checkReactionOnce(
  messageTs: string,
  channel: string = SLACK_CHANNEL,
): Promise<"approved" | "rejected" | "pending"> {
  if (!SLACK_TOKEN || !messageTs) return "approved";
  const reactions = await getReactions(messageTs, channel);
  if (reactions.some((r) => APPROVE_REACTIONS.includes(r))) {
    return "approved";
  }
  if (reactions.some((r) => REJECT_REACTIONS.includes(r))) {
    return "rejected";
  }
  return "pending";
}

// HITL 回答受理用：質問メッセージ(parentTs)のスレッド返信のうち、
// 「指定ユーザー(SLACK_MENTION_USER_ID→ASK_USER_ID→既定 U0AMRAQDW65)の非bot返信」の
// 最新テキストを返す。他者/bot/親メッセージは無視。channels:history/groups:history 必須。
export async function readLatestUserReply(
  parentTs: string,
  channel: string = SLACK_CHANNEL,
): Promise<string | null> {
  if (!SLACK_TOKEN || !parentTs) return null;
  const userId =
    process.env.SLACK_MENTION_USER_ID ?? process.env.ASK_USER_ID ?? "U0AMRAQDW65";
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(parentTs)}&limit=50`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } },
    );
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: { user?: string; bot_id?: string; text?: string; ts?: string }[];
    };
    if (!data.ok) {
      console.warn(`[SLACK] conversations.replies failed (${channel}): ${data.error}`);
      return null;
    }
    const replies = (data.messages ?? []).filter(
      (m) =>
        m.ts !== parentTs &&
        !m.bot_id &&
        m.user === userId &&
        (m.text ?? "").trim().length > 0,
    );
    if (replies.length === 0) return null;
    return (replies[replies.length - 1].text ?? "").trim();
  } catch (e) {
    console.warn(`[SLACK] conversations.replies error: ${e}`);
    return null;
  }
}

// 既存スレッドにメッセージを追加投稿し、そのメッセージの ts を返す。
// 後段の waitForReactionApproval / waitForReactionChoice にこの ts を渡すと、
// 同じメッセージのリアクションでユーザー応答を待ち受けられる。
export async function postSlackThread(threadTs: string, text: string): Promise<string> {
  const ts = await postMessage(text, threadTs);
  return ts ?? "";
}

// 既に投稿済みのメッセージ ts に対してリアクション (✅/❌) を待つ。
// 1 時間ごとにリマインドを同スレッドに流す。
export async function waitForReactionApproval(
  messageTs: string,
  threadTs?: string,
  onWaiting?: (elapsedSeconds: number) => void,
): Promise<SlackApprovalResult> {
  if (!SLACK_TOKEN || !messageTs) return "approved";

  let reminderCount = 0;
  const startTime = Date.now();
  let lastReminderTime = startTime;

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    onWaiting?.(elapsed);

    const reactions = await getReactions(messageTs);

    if (reactions.includes("white_check_mark") || reactions.includes("heavy_check_mark")) {
      return "approved";
    }

    if (reactions.includes("x") || reactions.includes("no_entry_sign")) {
      return "rejected";
    }

    const now = Date.now();
    if (now - lastReminderTime >= REMINDER_INTERVAL_MS) {
      reminderCount++;
      lastReminderTime = now;
      await postMessage(
        `🔔 *リマインド（${reminderCount}回目）*\n` +
          `承認待ちです。✅(実行) / ❌(スキップ) をリアクションしてください。\n` +
          `_待機時間: ${Math.round((now - startTime) / 60000)}分経過_`,
        threadTs,
      );
    }
  }
}

export async function waitForSlackApproval(
  projectTitle: string,
  description: string,
  threadTs?: string,
  onWaiting?: (elapsedSeconds: number) => void,
): Promise<SlackApprovalResult> {
  if (!SLACK_TOKEN) return "approved";

  const messageTs = await postMessage(
    `⚠️ *【${projectTitle}】承認が必要です*\n` +
      `内容: ${description}\n\n` +
      `✅ をリアクションで *承認*\n` +
      `❌ をリアクションで *却下*\n\n` +
      `_${new Date().toLocaleString("ja-JP")} | リアクションがあるまで待機します_`,
    threadTs,
  );

  if (!messageTs) return "approved";

  let reminderCount = 0;
  const startTime = Date.now();
  let lastReminderTime = startTime;

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    onWaiting?.(elapsed);

    const reactions = await getReactions(messageTs);

    if (reactions.includes("white_check_mark") || reactions.includes("heavy_check_mark")) {
      await postMessage(`✅ 承認されました。実装を続行します。`, threadTs);
      return "approved";
    }

    if (reactions.includes("x") || reactions.includes("no_entry_sign")) {
      await postMessage(`❌ 却下されました。実装を中止します。`, threadTs);
      return "rejected";
    }

    const now = Date.now();
    if (now - lastReminderTime >= REMINDER_INTERVAL_MS) {
      reminderCount++;
      lastReminderTime = now;
      await postMessage(
        `🔔 *リマインド（${reminderCount}回目）*\n` +
          `承認待ちです。リアクションで回答してください。\n` +
          `✅ 承認 / ❌ 却下\n` +
          `_待機時間: ${Math.round((now - startTime) / 60000)}分経過_`,
        threadTs,
      );
    }
  }
}

export async function waitForSlackChoice(
  projectTitle: string,
  prompt: string,
  choices: string[],
  threadTs?: string,
  onWaiting?: (elapsedSeconds: number) => void,
): Promise<number> {
  if (!SLACK_TOKEN) return 1;

  const EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
  const choiceLines = choices.map((c, i) => `${EMOJIS[i]} ${c}`).join("\n");

  const messageTs = await postMessage(
    `🔢 *【${projectTitle}】選択が必要です*\n\n` +
      `${prompt}\n\n` +
      `${choiceLines}\n\n` +
      `_リアクションで選択 | リアクションがあるまで待機します_`,
    threadTs,
  );

  if (!messageTs) return 1;

  let reminderCount = 0;
  const startTime = Date.now();
  let lastReminderTime = startTime;

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    onWaiting?.(elapsed);

    const reactions = await getReactions(messageTs);
    for (const reaction of reactions) {
      const num = NUMBER_EMOJI_REVERSE[reaction];
      if (num && num <= choices.length) {
        await postMessage(
          `✅ ${num}番「${choices[num - 1]}」が選択されました`,
          threadTs,
        );
        return num;
      }
    }

    const now = Date.now();
    if (now - lastReminderTime >= REMINDER_INTERVAL_MS) {
      reminderCount++;
      lastReminderTime = now;
      await postMessage(
        `🔔 *リマインド（${reminderCount}回目）*\n` +
          `選択待ちです。リアクションで回答してください。\n\n` +
          `${choiceLines}\n` +
          `_待機時間: ${Math.round((now - startTime) / 60000)}分経過_`,
        threadTs,
      );
    }
  }
}
