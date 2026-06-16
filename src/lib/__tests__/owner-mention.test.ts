// @mention 修正の自走式テスト（tsx + node:assert、vitest 不使用）。
//   実行: npx tsx src/lib/__tests__/owner-mention.test.ts
//
// 不具合: slack-notifier が owner.name だけ load し slackId を withMention に渡さず、
//   常に固定 U0AMRAQDW65（石井）にフォールバックしていた。
// 修正後の合成ロジック（projectNotifyMeta が pickMentionId で解決 → withMention(text, mentionId)）を
// 構成する純粋関数で検証する:
//   - pickMentionId: owner.slackId → creatorSlackId → undefined のチェーン
//   - withMention/mentionPrefix: mentionId 指定で owner、未指定で固定にフォールバック
//   - formatProjectLabel: ラベルは owner.name（従来どおり）

import assert from "node:assert/strict";
import { pickMentionId } from "../slack-mention";
import { mentionPrefix, withMention } from "../slack";
import { formatProjectLabel } from "../slack-notifier";

const FIXED = process.env.SLACK_MENTION_USER_ID ?? "U0AMRAQDW65";

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// --- 1. pickMentionId: 解決チェーン ---
test("owner.slackId あり → owner ID（固定にならない）", () => {
  const id = pickMentionId("UOWNER123", "UCREATOR9");
  assert.equal(id, "UOWNER123");
  assert.notEqual(id, FIXED);
});

test("owner なし → creatorSlackId", () => {
  assert.equal(pickMentionId(null, "UCREATOR9"), "UCREATOR9");
  assert.equal(pickMentionId("   ", "UCREATOR9"), "UCREATOR9");
});

test("owner も creator も無し → undefined（呼び出し側で固定にフォールバック）", () => {
  assert.equal(pickMentionId(null, null), undefined);
  assert.equal(pickMentionId(undefined, undefined), undefined);
});

// --- 2. withMention / mentionPrefix: 固定フォールバックの境界 ---
test("mentionId 指定（owner）→ owner を mention し固定を含まない", () => {
  const pre = mentionPrefix("UOWNER123");
  assert.equal(pre, "<@UOWNER123> ");
  assert.equal(pre.includes(FIXED), false);
  assert.equal(withMention("本文", "UOWNER123"), "<@UOWNER123> 本文");
});

test("mentionId 未指定 → 固定 ID にフォールバック（owner 未登録時の最終手段）", () => {
  assert.equal(mentionPrefix(undefined), `<@${FIXED}> `);
  assert.equal(withMention("本文", undefined), `<@${FIXED}> 本文`);
});

test("合成: owner.slackId を pickMentionId→withMention に通すと owner が mention される", () => {
  const mentionId = pickMentionId("UOWNER123", null); // owner 登録済み
  assert.equal(withMention("🚀 開発開始", mentionId), "<@UOWNER123> 🚀 開発開始");
  // 旧バグ（mentionId を渡さない）だと固定になることの対比
  assert.equal(withMention("🚀 開発開始"), `<@${FIXED}> 🚀 開発開始`);
});

// --- 3. formatProjectLabel: ラベルは owner.name（従来どおり） ---
test("ラベルは owner.name で正しい（mention とは独立）", () => {
  assert.equal(formatProjectLabel("佐瀬 光", "POS会計"), "【佐瀬 光】POS会計");
});

test("owner.name 未設定はラベル 'ごう' にフォールバック", () => {
  assert.equal(formatProjectLabel(null, "POS会計"), "【ごう】POS会計");
  assert.equal(formatProjectLabel("  ", "POS会計"), "【ごう】POS会計");
});

// --- runner ---
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
