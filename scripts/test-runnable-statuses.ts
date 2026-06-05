// RUNNABLE_PARALLEL_STATUSES が processOneTick の dispatch と一致することを検証する
// （npx tsx scripts/test-runnable-statuses.ts）。
//
// 回帰の本丸：worker ループの唯一の取得経路 findRunnableProjects がこの集合を毎 tick 取得する。
// dispatch が advance できる状態がこの集合から漏れると、その状態に遷移した project が二度と
// fetch されず state machine が停止する（running→verifying で永久停止していた欠陥）。
// dispatch（src/lib/parallel-tick.ts processOneTick）を変更したら、ここの期待集合も更新すること。
import assert from "node:assert/strict";
// prisma 非依存の parallel-status から import（副作用なし・DATABASE_URL 不要で単独実行可能）。
import { RUNNABLE_PARALLEL_STATUSES } from "../src/lib/parallel-status";

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }

const runnable = new Set<string>(RUNNABLE_PARALLEL_STATUSES);

// processOneTick の dispatch が専用 advance に流す（＝毎 tick の駆動が必要な）全状態。
// scaffolding→advanceScaffolding / verifying・needs_review→advanceVerification /
// deploying・awaiting_qa→advancePreviewQa / running→本体ロジック。
const DISPATCH_ADVANCEABLE = [
  "running",
  "scaffolding",
  "verifying",
  "needs_review",
  "deploying",
  "awaiting_qa",
];

// 取得してはいけない状態：terminal / 遷移中の claim センチネル。
// done=完了, scaffold_error=手動リトライ待ち, scaffolding_active=scaffold 実行中の claim。
const NON_RUNNABLE = ["done", "scaffold_error", "scaffolding_active"];

console.log("RUNNABLE_PARALLEL_STATUSES");
t("dispatch が advance できる全状態を含む（漏れると永久停止）", () => {
  for (const s of DISPATCH_ADVANCEABLE) {
    assert.ok(runnable.has(s), `runnable に "${s}" が無い → ${s} 遷移後に worker が停止する`);
  }
});
t("verifying / deploying / awaiting_qa を確実に含む（D/E の本丸）", () => {
  assert.ok(runnable.has("verifying"), "verifying 欠落＝検証ゲートが進まない");
  assert.ok(runnable.has("deploying"), "deploying 欠落＝preview がデプロイされない");
  assert.ok(runnable.has("awaiting_qa"), "awaiting_qa 欠落＝QA の ✅/コメントが検出されない");
});
t("terminal / claim 中の状態は含まない", () => {
  for (const s of NON_RUNNABLE) {
    assert.ok(!runnable.has(s), `runnable に terminal/claim 状態 "${s}" が混入`);
  }
});
t("集合は dispatch と過不足なく一致（drift 検出）", () => {
  assert.deepEqual([...runnable].sort(), [...DISPATCH_ADVANCEABLE].sort());
});
t("重複が無い", () => {
  assert.equal(runnable.size, RUNNABLE_PARALLEL_STATUSES.length);
});

console.log(`\n✅ all ${passed} tests passed`);
