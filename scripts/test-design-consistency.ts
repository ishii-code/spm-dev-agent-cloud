// design-consistency.ts のテスト（npx tsx scripts/test-design-consistency.ts）。
// 純ロジック（precheckCoverage / buildDesignCriticPrompt）を検証。critic 本体は LLM のため replay で確認。
import assert from "node:assert/strict";
import { precheckCoverage, buildDesignCriticPrompt } from "../src/lib/design-consistency";

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const REQ =
  "受付なし。猫専用診察室は4㎡、犬専用診察室は10㎡で兼オペ。聴覚分離の動線。A/Bパターン。予算300万円。";

console.log("precheckCoverage");
t("設計に全シグナルがあれば欠落ゼロ", () => {
  const design = "4㎡ 10㎡ 兼オペ 聴覚分離 動線 A/Bパターン 300万円 診察室 受付";
  assert.equal(precheckCoverage(REQ, design).length, 0);
});
t("設計に無いシグナルを欠落として返す", () => {
  const design = "4㎡ 兼オペ A/Bパターン"; // 10㎡/聴覚分離/300万円/診察室/受付 が欠落
  const miss = precheckCoverage(REQ, design).map((c) => c.signal);
  assert.ok(miss.includes("10㎡"));
  assert.ok(miss.some((s) => s.includes("聴覚分離")));
  assert.ok(miss.includes("300万円"));
});
t("token一致は受付なし/受付ありを区別しない（pre-checkの限界＝criticに委譲）", () => {
  // 設計に「受付」を足してしまっても、signal『受付』は存在するので pre-check は欠落と見なさない。
  // → 反転（受付なし→受付混入）は pre-check では検出不可。これを critic が担う前提。
  const designWithReception = "受付カウンターを設置。4㎡ 10㎡ 兼オペ 聴覚分離 A/Bパターン 300万円";
  const miss = precheckCoverage(REQ, designWithReception).map((c) => c.signal);
  assert.ok(!miss.includes("受付"), "pre-check は『受付』混入を検出しない（仕様どおり）");
});

console.log("buildDesignCriticPrompt");
t("要件/設計/除外反転チェック/VERIFY を含む", () => {
  const p = buildDesignCriticPrompt(REQ, "設計本文ABC", ["10㎡"]);
  assert.match(p, /受付なし/); // 除外反転の例示
  assert.match(p, /設計に受付/); // 反転チェック指示
  assert.match(p, /仕様外混入/);
  assert.match(p, /カバレッジ/);
  assert.match(p, /設計本文ABC/);
  assert.match(p, /\[\[VERIFY\]\]/);
  assert.match(p, /10㎡/); // pre-check ヒント
});
t("ヒント無しでも成立", () => {
  const p = buildDesignCriticPrompt(REQ, "設計", []);
  assert.match(p, /\[\[VERIFY\]\]/);
  assert.doesNotMatch(p, /pre-check が「設計に見当たらない」/);
});

console.log(`\n✅ all ${passed} tests passed`);
