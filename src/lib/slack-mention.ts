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

// 受理ユーザー ID 集合（owner∪admin）を組む（純粋）。owner(mentionId) が空なら admin 単独。
// 重複は除去。anti-spoof: ここに含まれないユーザーの返信/リアクションは受理しない。
export function acceptIdsFrom(
  ownerMentionId: string | null | undefined,
  fixedAdminId: string,
): string[] {
  return Array.from(
    new Set([ownerMentionId, fixedAdminId].filter((v): v is string => Boolean(v && v.trim()))),
  );
}

// reactions.get 由来の 1 リアクション（emoji 名＋付与ユーザー一覧）。
export interface SlackReaction {
  name: string;
  users: string[];
}

const APPROVE_REACTIONS = ["white_check_mark", "heavy_check_mark", "+1", "thumbsup"];
const REJECT_REACTIONS = ["x", "no_entry_sign"];

// 受理ユーザー(acceptUserIds)が付けた reaction の emoji 名だけを返す（純粋）。
// 共有チャンネルで第三者の reaction を弾くための核。acceptUserIds 空なら誰も採用しない（安全側）。
export function acceptedReactionNames(
  reactions: SlackReaction[],
  acceptUserIds: string[],
): string[] {
  if (!acceptUserIds.length) return [];
  return reactions
    .filter((r) => (r.users ?? []).some((u) => acceptUserIds.includes(u)))
    .map((r) => r.name);
}

// 承認/拒否/保留の判定（純粋）。受理ユーザーが付けた ✅/👍 → approved、❌ → rejected、無し → pending。
export function reactionVerdict(
  reactions: SlackReaction[],
  acceptUserIds: string[],
): "approved" | "rejected" | "pending" {
  const names = acceptedReactionNames(reactions, acceptUserIds);
  if (names.some((n) => APPROVE_REACTIONS.includes(n))) return "approved";
  if (names.some((n) => REJECT_REACTIONS.includes(n))) return "rejected";
  return "pending";
}

// HITL 回答の選定（純粋）。replies は受理対象ユーザーの返信を時系列（古→新）で渡す。
//  - choices あり（番号選択式）: 新しい順に最初の「有効な番号(1..N)」を採用し対応 choice を返す。
//    番号でない meta テキスト（質問の言い換え/補足等）は回答にしない（null のまま）。
//  - choices なし（自由記述）: 最新の非空返信を採用。
export function pickHitlAnswer(replies: string[], choices: string[]): string | null {
  if (choices.length > 0) {
    // 新しい順に、返信全体が「番号のみ」または「英字ラベルのみ(A/B/C/D…)」の時だけ採用。
    // 番号⇔ラベル対応（A=1, B=2, …）で解決し、範囲外は invalid（採用しない）。meta 文は除外。
    for (let i = replies.length - 1; i >= 0; i--) {
      const idx = parseChoiceIndex(replies[i]);
      if (idx !== null && idx >= 1 && idx <= choices.length) return choices[idx - 1];
    }
    return null;
  }
  for (let i = replies.length - 1; i >= 0; i--) {
    const t = replies[i].trim();
    if (t) return t;
  }
  return null;
}

// 返信全体が「番号のみ」or「英字ラベル1文字のみ」なら 1 始まりの選択肢インデックスを返す。
// 全角（１/Ａ 等）は NFKC で半角化してから判定。末尾装飾（. ) 。番 : 等）は許容。該当外は null。
export function parseChoiceIndex(raw: string): number | null {
  const t = (raw ?? "").normalize("NFKC").trim();
  const num = t.match(/^(\d+)[.)．）。番:：]?$/);
  if (num) return Number.parseInt(num[1], 10);
  const letter = t.match(/^([A-Za-z])[.)．）。:：]?$/);
  if (letter) return letter[1].toUpperCase().charCodeAt(0) - 64; // A=1, B=2, …
  return null;
}
