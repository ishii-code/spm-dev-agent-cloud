// Slack メンション関連の純粋ロジック（依存なし＝サーバ/クライアント共用・テスト可）。

// メンション対象 ID のチェーン解決（先頭の非空を採用）：
//   owner.slackId → creatorSlackId → undefined（呼び出し側で固定 SLACK_MENTION_USER_ID にフォールバック）。
export function pickMentionId(
  ownerSlackId: string | null | undefined,
  creatorSlackId: string | null | undefined,
): string | undefined {
  const o = ownerSlackId?.trim();
  if (o) return o;
  const c = creatorSlackId?.trim();
  if (c) return c;
  return undefined;
}

// Slack の「メンバーID」（U… / W… 形式）か軽くバリデーション。@ハンドルや表示名は不可。
// 空文字（=設定解除）は呼び出し側で別途許容する想定（ここでは false）。
export function isValidSlackMemberId(s: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(s);
}
