// requirements-constraints.ts のテスト（npx tsx scripts/test-requirements-constraints.ts）。
// spm-clinic-layout 相当の入力で抽出・充足チェック・逐語転記の往復を検証。
import assert from "node:assert/strict";
import {
  extractConstraints,
  findMissingConstraints,
  buildConstraintAppendix,
} from "../src/lib/requirements-constraints";

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// clinic 相当のユーザー入力（具体仕様：面積/部屋/機器/動線/コスト）。
const CLINIC_INPUT =
  "テナントは120㎡、予算は300万円です。\n" +
  "猫専用診察室と犬専用診察室を分けてください。受付カウンターも必要です。\n" +
  "処置室は兼オペにします。レントゲン室とエコー機器を置きます。\n" +
  "聴覚分離の動線にして、レイアウトはA/Bパターンで比較したい。診察室は2室。";

console.log("extractConstraints");
t("面積/コスト/部屋/機器/動線/個数を抽出", () => {
  const cs = extractConstraints(CLINIC_INPUT);
  const sigs = cs.map((c) => c.signal);
  for (const s of ["120㎡", "300万円", "診察室", "受付カウンター", "兼オペ", "レントゲン", "エコー", "聴覚分離", "2室"]) {
    assert.ok(sigs.some((x) => x.includes(s) || s.includes(x)), `signal 不足: ${s}`);
  }
  const cats = new Set(cs.map((c) => c.category));
  for (const cat of ["area", "cost", "room", "equipment", "flow", "count"]) {
    assert.ok(cats.has(cat as never), `category 不足: ${cat}`);
  }
});
t("同一シグナルは重複排除", () => {
  const cs = extractConstraints("受付。受付。受付カウンター。");
  const recep = cs.filter((c) => c.signal === "受付");
  assert.equal(recep.length, 1);
});
t("数値/キーワードなし文は拾わない", () => {
  assert.deepEqual(extractConstraints("よろしくお願いします"), []);
});

console.log("findMissingConstraints");
t("doc にシグナルがあれば missing から外れる", () => {
  const cs = extractConstraints("120㎡で受付が必要");
  const doc = "面積は120㎡を想定。受付を設ける。";
  assert.equal(findMissingConstraints(cs, doc).length, 0);
});
t("わざと1項目（受付）を doc から落とすと検知", () => {
  const cs = extractConstraints(CLINIC_INPUT);
  // 受付カウンターだけ欠落した doc
  const doc = "120㎡ 300万円 猫専用診察室 犬専用診察室 兼オペ レントゲン エコー 聴覚分離 A/Bパターン 2室";
  const missing = findMissingConstraints(cs, doc);
  assert.ok(missing.some((m) => m.signal.includes("受付")), "受付の欠落を検知できていない");
});

console.log("buildConstraintAppendix + 往復（充足保証）");
t("逐語転記で元の文が含まれる", () => {
  const cs = extractConstraints("予算は300万円です");
  const ap = buildConstraintAppendix(cs);
  assert.match(ap, /原文転記/);
  assert.match(ap, /予算は300万円です/);
});
t("doc に未反映 → 転記 → 再チェックで欠落ゼロ（充足保証）", () => {
  const cs = extractConstraints(CLINIC_INPUT);
  const emptyDoc = "目的\n（要約のみで具体が落ちた要件定義書）";
  const missing = findMissingConstraints(cs, emptyDoc);
  assert.ok(missing.length > 0, "前提：未反映があるはず");
  const finalDoc = `${emptyDoc}\n\n${buildConstraintAppendix(missing)}`;
  const stillMissing = findMissingConstraints(cs, finalDoc);
  assert.equal(stillMissing.length, 0, "逐語転記後も欠落が残っている");
});

console.log(`\n✅ all ${passed} tests passed`);
