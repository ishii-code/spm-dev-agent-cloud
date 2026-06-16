// 承認チャンネル化に伴う anti-spoof（受理ユーザー絞り込み）の純関数テスト。
//   実行: npx tsx src/lib/__tests__/reaction-accept.test.ts
//
// 検証:
//   - acceptIdsFrom: owner∪admin / owner欠落でadmin単独 / 重複除去
//   - acceptedReactionNames・reactionVerdict: owner/admin の reaction のみ採用、第三者は無視（誤受理しない）
//   - pickHitlAnswer: 番号選択採用 / meta テキスト無視 / 自由記述は最新

import assert from "node:assert/strict";
import {
  acceptIdsFrom,
  acceptedReactionNames,
  reactionVerdict,
  pickHitlAnswer,
  type SlackReaction,
} from "../slack-mention";

const OWNER = "UOWNER1";   // project owner（佐瀬）
const ADMIN = "U0AMRAQDW65"; // 固定 admin（石井）
const OTHER = "USTRANGER";  // 第三者

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// --- acceptIdsFrom ---
test("acceptIdsFrom: owner∪admin", () => {
  assert.deepEqual(acceptIdsFrom(OWNER, ADMIN), [OWNER, ADMIN]);
});
test("acceptIdsFrom: owner 欠落 → admin 単独", () => {
  assert.deepEqual(acceptIdsFrom(null, ADMIN), [ADMIN]);
  assert.deepEqual(acceptIdsFrom("  ", ADMIN), [ADMIN]);
});
test("acceptIdsFrom: owner==admin は重複除去", () => {
  assert.deepEqual(acceptIdsFrom(ADMIN, ADMIN), [ADMIN]);
});

// --- acceptedReactionNames ---
const reacts = (n: string, ...users: string[]): SlackReaction => ({ name: n, users });
test("acceptedReactionNames: owner/admin の reaction のみ", () => {
  const r = [reacts("white_check_mark", OTHER, OWNER), reacts("x", OTHER)];
  assert.deepEqual(acceptedReactionNames(r, [OWNER, ADMIN]), ["white_check_mark"]);
});
test("acceptedReactionNames: 受理空なら何も採用しない", () => {
  assert.deepEqual(acceptedReactionNames([reacts("white_check_mark", OWNER)], []), []);
});

// --- reactionVerdict（誤受理防止の核）---
test("owner の ✅ → approved", () => {
  assert.equal(reactionVerdict([reacts("white_check_mark", OWNER)], [OWNER, ADMIN]), "approved");
});
test("admin の 👍 → approved", () => {
  assert.equal(reactionVerdict([reacts("thumbsup", ADMIN)], [OWNER, ADMIN]), "approved");
});
test("owner の ❌ → rejected", () => {
  assert.equal(reactionVerdict([reacts("x", OWNER)], [OWNER, ADMIN]), "rejected");
});
test("第三者だけが ✅ → pending（誤受理しない）", () => {
  assert.equal(reactionVerdict([reacts("white_check_mark", OTHER)], [OWNER, ADMIN]), "pending");
});
test("第三者 ✅ ＋ owner 無反応 → pending", () => {
  assert.equal(
    reactionVerdict([reacts("white_check_mark", OTHER), reacts("x", OTHER)], [OWNER, ADMIN]),
    "pending",
  );
});

// --- pickHitlAnswer（meta 無視）---
test("番号選択: 有効番号を採用", () => {
  assert.equal(pickHitlAnswer(["1"], ["A案", "B案"]), "A案");
});
test("番号選択: meta テキストは無視（番号のみ採用）", () => {
  assert.equal(pickHitlAnswer(["これはどういう意味ですか？", "2"], ["A案", "B案"]), "B案");
  assert.equal(pickHitlAnswer(["雑談です"], ["A案", "B案"]), null);
});
test("自由記述: 最新の非空返信", () => {
  assert.equal(pickHitlAnswer(["古い回答", "新しい回答"], []), "新しい回答");
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
