// ③表示バグ client 修正の自走式テスト（tsx + node:assert、vitest 不使用）。
//   実行: npx tsx src/lib/__tests__/chat-rehydrate.test.ts
//
// 復帰時の messages 採用判定（preferCachedOnLoad）と placeholder の pending 除去（stripPending）。
// 検証（両方向・必須）:
//   - 復帰後(非ストリーミング): cache の途中版を優先しない → DB 全文を採用（③修正）
//   - 同一 tab で生成中: live(cache) を保持 → DB fetch で消えない（回帰防止）

import assert from "node:assert/strict";
import { preferCachedOnLoad, stripPending } from "../chat-rehydrate";

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

type Msg = { id: string; role: string; content: string; pending?: boolean };
const stalePartial: Msg[] = [{ id: "a", role: "orchestrator", content: "要件定義書 …入力した内容が安全に", pending: true }];
const liveMsgs: Msg[] = [{ id: "a", role: "orchestrator", content: "生成中…", pending: true }];

// --- preferCachedOnLoad: ③核心（復帰時は DB 優先） ---
test("復帰後(非ストリーミング)は cache を優先しない → DB 全文採用", () => {
  // 途中版 cache があっても false（＝DB 結果をそのまま使う＝stale で上書きしない）
  assert.equal(preferCachedOnLoad(false, stalePartial), false);
});

test("同一 tab で生成中は live(cache) を保持（DB fetch で消さない＝回帰防止）", () => {
  assert.equal(preferCachedOnLoad(true, liveMsgs), true);
});

test("生成中でも cache が空/未定義なら DB 採用", () => {
  assert.equal(preferCachedOnLoad(true, []), false);
  assert.equal(preferCachedOnLoad(true, null), false);
  assert.equal(preferCachedOnLoad(true, undefined), false);
});

test("非ストリーミング＋cache無しは当然 DB 採用", () => {
  assert.equal(preferCachedOnLoad(false, null), false);
});

test("isStreaming は厳密 true のみ cache 優先（truthy だけでは不可）", () => {
  assert.equal(preferCachedOnLoad(1 as unknown as boolean, liveMsgs), false);
});

// --- stripPending: 固まったカーソルを placeholder に残さない ---
test("stripPending は pending=true を false に落とす（content は保持）", () => {
  const out = stripPending(stalePartial);
  assert.equal(out[0].pending, false);
  assert.equal(out[0].content, stalePartial[0].content);
});

test("stripPending は非破壊（元配列を変更しない）", () => {
  const input: Msg[] = [{ id: "x", role: "user", content: "hi", pending: true }];
  const out = stripPending(input);
  assert.equal(input[0].pending, true, "元配列は不変であるべき");
  assert.notEqual(out[0], input[0], "pending 行は新オブジェクトに置換");
});

test("stripPending は pending 無し行をそのまま返す（同一参照）", () => {
  const input: Msg[] = [{ id: "y", role: "user", content: "done" }];
  const out = stripPending(input);
  assert.equal(out[0], input[0]);
});

// --- runner ---
let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✅ ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${t.name}`);
    console.error(`     ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
if (failed > 0) process.exit(1);
