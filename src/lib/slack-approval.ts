// Slackのリアクションをポーリングして承認可否を取得する。
// 必要なBotスコープ：
//   - chat:write  （承認リクエスト／結果メッセージの送信）
//   - reactions:read（✅/❌ リアクションの取得）
// Slackアプリ設定 > OAuth & Permissions で reactions:read を追加し、
// ワークスペースに再インストールすること。

const SLACK_CHANNEL = "C0B3D1S0LER";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const POLL_INTERVAL_MS = 5000;
const REMINDER_INTERVAL_MS = 3_600_000;

const NUMBER_EMOJI_REVERSE: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

async function postMessage(text: string, threadTs?: string): Promise<string | undefined> {
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
        text,
        thread_ts: threadTs,
      }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch {
    return undefined;
  }
}

async function getReactions(messageTs: string): Promise<string[]> {
  if (!SLACK_TOKEN) return [];
  try {
    const res = await fetch(
      `https://slack.com/api/reactions.get?channel=${SLACK_CHANNEL}&timestamp=${encodeURIComponent(messageTs)}`,
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
//   - ✅（white_check_mark / heavy_check_mark）→ "approved"
//   - ❌（x / no_entry_sign）→ "rejected"
//   - どちらも無し → "pending"
//   - Slack 未設定 / messageTs 空 → "approved"（仕様通り）
export async function checkReactionOnce(
  messageTs: string,
  threadTs?: string,
): Promise<"approved" | "rejected" | "pending"> {
  void threadTs;
  if (!SLACK_TOKEN || !messageTs) return "approved";
  const reactions = await getReactions(messageTs);
  if (
    reactions.includes("white_check_mark") ||
    reactions.includes("heavy_check_mark")
  ) {
    return "approved";
  }
  if (reactions.includes("x") || reactions.includes("no_entry_sign")) {
    return "rejected";
  }
  return "pending";
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
