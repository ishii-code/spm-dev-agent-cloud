// C クイックウィン3点のユニット（npx tsx scripts/test-c-quickwins.ts）。
//  1) formatJst/formatJstDate（JST 固定）  2) formatProjectLabel（B2 登録者名）
//  3) pickHitlAnswer/parseChoiceIndex（番号＋英字ラベル）
import assert from "node:assert/strict";
import { formatJst, formatJstDate } from "../src/lib/time";
import { formatProjectLabel } from "../src/lib/slack-notifier";
import { pickHitlAnswer, parseChoiceIndex } from "../src/lib/slack-mention";

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log("formatJst / formatJstDate (JST)");
t("UTC 00:00 → JST 9:00（+9h）", () => {
  const d = new Date("2026-06-04T00:00:00Z");
  const s = formatJst(d);
  assert.match(s, /2026\/6\/4/);
  assert.match(s, /9:00:00/);
});
t("UTC で日付跨ぎ → JST 翌日（TZ 適用の証明）", () => {
  const d = new Date("2026-06-03T20:00:00Z"); // JST=翌4日 05:00
  assert.match(formatJstDate(d), /2026\/6\/4/);
  assert.match(formatJst(d), /5:00:00/);
});

console.log("formatProjectLabel (B2)");
t("owner名あり → 【名前】タイトル", () => {
  assert.equal(formatProjectLabel("石井豪", "クリニックアプリ"), "【石井豪】クリニックアプリ");
});
t("owner未設定 → 【ごう】フォールバック", () => {
  assert.equal(formatProjectLabel(null, "アプリ"), "【ごう】アプリ");
  assert.equal(formatProjectLabel("  ", "アプリ"), "【ごう】アプリ");
});

console.log("parseChoiceIndex");
t("番号", () => { assert.equal(parseChoiceIndex("1"), 1); assert.equal(parseChoiceIndex("3."), 3); assert.equal(parseChoiceIndex("10"), 10); });
t("英字ラベル A=1,B=2,C=3", () => { assert.equal(parseChoiceIndex("A"), 1); assert.equal(parseChoiceIndex("b"), 2); assert.equal(parseChoiceIndex("C)"), 3); });
t("全角（１/Ｂ）も NFKC で解決", () => { assert.equal(parseChoiceIndex("１"), 1); assert.equal(parseChoiceIndex("Ｂ"), 2); });
t("非該当は null", () => { assert.equal(parseChoiceIndex("あ"), null); assert.equal(parseChoiceIndex("AB"), null); assert.equal(parseChoiceIndex("はい"), null); });

console.log("pickHitlAnswer (番号＋ラベル)");
const choices = ["朝", "昼", "夜"];
t("番号で解決", () => { assert.equal(pickHitlAnswer(["2"], choices), "昼"); });
t("英字ラベルで解決", () => { assert.equal(pickHitlAnswer(["B"], choices), "昼"); assert.equal(pickHitlAnswer(["c"], choices), "夜"); });
t("範囲外は invalid（採用しない）", () => {
  assert.equal(pickHitlAnswer(["D"], choices), null); // 4 > 3
  assert.equal(pickHitlAnswer(["9"], choices), null);
});
t("新しい順（最後の有効回答）", () => { assert.equal(pickHitlAnswer(["A", "C"], choices), "夜"); });
t("meta 文は無視", () => { assert.equal(pickHitlAnswer(["どれがいい？", "1"], choices), "朝"); });
t("自由記述（choices空）は最新非空", () => { assert.equal(pickHitlAnswer(["古い", "新しい回答"], []), "新しい回答"); });

console.log(`\n✅ all ${passed} tests passed`);
