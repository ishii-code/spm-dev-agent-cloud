// 全 Slack 通知の冒頭に必ずメンションを付与するための共通ヘルパー。
// 既存の slack-notifier.ts / slack-approval.ts の送信チョークポイントから withMention() を
// 通すことで「全通知メンション必須」を一元的に担保する。

const MENTION_USER_ID = process.env.SLACK_MENTION_USER_ID ?? "U0AMRAQDW65";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

// メンション対象 ID を解決：指定があればそれ、無ければ固定 SLACK_MENTION_USER_ID（後方互換）。
// Phase3：owner.slackId → creatorSlackId → 固定 のチェーンは mentionFor() が解決し結果を渡す。
function resolveMentionId(mentionId?: string | null): string {
  return (mentionId && mentionId.trim()) || MENTION_USER_ID || "";
}

// `<@U...> ` 形式のメンション接頭辞。未設定なら空文字。
export function mentionPrefix(mentionId?: string | null): string {
  const id = resolveMentionId(mentionId);
  return id ? `<@${id}> ` : "";
}

// 本文の冒頭にメンションを付与する（既に付いていれば二重付与しない）。
export function withMention(text: string, mentionId?: string | null): string {
  const id = resolveMentionId(mentionId);
  if (!id) return text;
  if (text.startsWith(`<@${id}>`)) return text;
  return `<@${id}> ` + text;
}

// 任意のチャンネル / ユーザーID へメンション付きで送信する。
// channelOrUserId が User ID(U.../W...) の場合は DM チャンネルを open して送る。
// 戻り値は投稿メッセージの ts（失敗時 undefined）。
export async function sendSlackWithMention(
  channelOrUserId: string,
  message: string,
): Promise<string | undefined> {
  if (!SLACK_TOKEN || !channelOrUserId) return undefined;
  let channel = channelOrUserId;
  if (/^[UW]/.test(channelOrUserId)) {
    try {
      const r = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SLACK_TOKEN}`,
        },
        body: JSON.stringify({ users: channelOrUserId }),
      });
      const d = (await r.json()) as { ok: boolean; channel?: { id?: string } };
      if (d.ok && d.channel?.id) channel = d.channel.id;
    } catch {
      // open 失敗時はそのまま channelOrUserId を channel として試す
    }
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({ channel, text: withMention(message) }),
    });
    const data = (await res.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch {
    return undefined;
  }
}
