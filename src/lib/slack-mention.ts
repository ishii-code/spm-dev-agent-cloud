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

// HITL 回答の選定（純粋）。replies は受理対象ユーザーの返信を時系列（古→新）で渡す。
//  - choices あり（番号選択式）: 新しい順に最初の「有効な番号(1..N)」を採用し対応 choice を返す。
//    番号でない meta テキスト（質問の言い換え/補足等）は回答にしない（null のまま）。
//  - choices なし（自由記述）: 最新の非空返信を採用。
export function pickHitlAnswer(replies: string[], choices: string[]): string | null {
  if (choices.length > 0) {
    // 返信全体が「番号のみ」（任意の末尾装飾 . ) 。番 : は許容）の時だけ採用。meta 文は除外。
    const NUM_ONLY = /^\s*(\d+)\s*[.)．）。番:：]?\s*$/;
    for (let i = replies.length - 1; i >= 0; i--) {
      const m = replies[i].trim().match(NUM_ONLY);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (n >= 1 && n <= choices.length) return choices[n - 1];
      }
    }
    return null;
  }
  for (let i = replies.length - 1; i >= 0; i--) {
    const t = replies[i].trim();
    if (t) return t;
  }
  return null;
}
