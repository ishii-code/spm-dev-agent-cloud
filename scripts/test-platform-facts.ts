// platform-facts.ts のテストハーネス（npx tsx scripts/test-platform-facts.ts）。
// 接地定数が必須スタックを含み、禁止スタックを含まないこと＋前置ヘルパーを検証。
import assert from "node:assert/strict";
import { PLATFORM_FACTS, withPlatformFacts } from "../src/lib/platform-facts";

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("PLATFORM_FACTS 内容");
t("必須スタックを含む（Cloud SQL/Prisma/jose/Cloud Run/vanilla Next.js/Tailwind/buildpacks）", () => {
  for (const kw of [
    "Cloud SQL",
    "PostgreSQL",
    "Prisma",
    "jose",
    "Cloud Run",
    "Next.js",
    "App Router",
    "Tailwind",
    "buildpacks",
  ]) {
    assert.ok(PLATFORM_FACTS.includes(kw), `missing: ${kw}`);
  }
});
t("禁止スタックを明示（Supabase / Vercel / Supabase Auth）", () => {
  assert.match(PLATFORM_FACTS, /Supabase/);
  assert.match(PLATFORM_FACTS, /Vercel/);
  assert.match(PLATFORM_FACTS, /使用しない/);
});
t("指定外スタック禁止・事実ベース統一の文言", () => {
  assert.match(PLATFORM_FACTS, /勝手に選ばない/);
  assert.match(PLATFORM_FACTS, /事実に反する統一主張をしない/);
});
t("OS統合：独自認証を入れない（単一ログイン）", () => {
  assert.match(PLATFORM_FACTS, /独自のログイン\/認証を入れない/);
});
t("MVP 無永続・永続化は後付け Cloud SQL", () => {
  assert.match(PLATFORM_FACTS, /MVP は無永続/);
  assert.match(PLATFORM_FACTS, /後付け/);
});

console.log("withPlatformFacts");
t("プロンプト先頭に接地を前置し本文を保持", () => {
  const out = withPlatformFacts("実装してください：機能X");
  assert.ok(out.startsWith("## 実プラットフォーム事実"));
  assert.match(out, /実装してください：機能X/);
  assert.match(out, /---/); // 区切り
});

console.log(`\n✅ all ${passed} tests passed`);
