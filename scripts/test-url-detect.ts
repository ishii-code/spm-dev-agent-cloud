// url-detect.ts のテストハーネス（tsx で実行： npx tsx scripts/test-url-detect.ts）。
// 正式テストFW未導入のため、node:assert による自己完結ハーネス（既存慣習に準拠）。
import assert from "node:assert/strict";
import {
  extractUrls,
  classifyUrl,
  buildUnreadableUrlNotice,
} from "../src/lib/url-detect";

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("extractUrls");
t("URL 無しは空配列", () => {
  assert.deepEqual(extractUrls("ただのテキスト"), []);
  assert.deepEqual(extractUrls(""), []);
});
t("単純な https を抽出", () => {
  assert.deepEqual(extractUrls("見て https://example.com/page"), [
    "https://example.com/page",
  ]);
});
t("末尾の句読点・全角括弧を除去", () => {
  assert.deepEqual(extractUrls("これ（https://example.com/a）です。"), [
    "https://example.com/a",
  ]);
  assert.deepEqual(extractUrls("https://example.com/b。"), [
    "https://example.com/b",
  ]);
});
t("複数 URL・重複排除（出現順維持）", () => {
  assert.deepEqual(
    extractUrls("https://a.com と https://b.com と https://a.com"),
    ["https://a.com", "https://b.com"],
  );
});
t("http も対象 / mailto・ftp は対象外", () => {
  assert.deepEqual(extractUrls("http://x.com mailto:a@b.com ftp://y.com"), [
    "http://x.com",
  ]);
});

console.log("classifyUrl");
t("Notion は auth_required", () => {
  assert.equal(
    classifyUrl("https://www.notion.so/abc123").reason,
    "auth_required",
  );
  assert.equal(
    classifyUrl("https://team.notion.site/page").reason,
    "auth_required",
  );
});
t("Google Docs は auth_required", () => {
  assert.equal(
    classifyUrl("https://docs.google.com/document/d/xxx").reason,
    "auth_required",
  );
});
t("一般公開ドメインは no_tool", () => {
  assert.equal(classifyUrl("https://example.com/x").reason, "no_tool");
  assert.equal(classifyUrl("https://github.com/o/r").reason, "no_tool");
});
t("解析不能 URL は no_tool（例外を投げない）", () => {
  assert.equal(classifyUrl("https://").reason, "no_tool");
});
t("末尾一致のなりすまし回避（notion.so.evil.com は no_tool）", () => {
  assert.equal(
    classifyUrl("https://notion.so.evil.com/x").reason,
    "no_tool",
  );
});

console.log("buildUnreadableUrlNotice");
t("URL 無しは null（バブル不要）", () => {
  assert.equal(buildUnreadableUrlNotice("URLなし"), null);
});
t("auth_required の文面を含む", () => {
  const out = buildUnreadableUrlNotice("https://notion.so/x を参照");
  assert.ok(out);
  assert.match(out!, /読み取れませんでした/);
  assert.match(out!, /認証が必要/);
  assert.match(out!, /https:\/\/notion\.so\/x/);
  assert.match(out!, /貼り付け/);
});
t("no_tool の文面を含む", () => {
  const out = buildUnreadableUrlNotice("https://example.com/x");
  assert.ok(out);
  assert.match(out!, /自動取得する手段がない/);
});
t("複数 URL を列挙", () => {
  const out = buildUnreadableUrlNotice(
    "https://notion.so/a と https://example.com/b",
  );
  assert.ok(out);
  assert.match(out!, /https:\/\/notion\.so\/a/);
  assert.match(out!, /https:\/\/example\.com\/b/);
});

console.log(`\n✅ all ${passed} tests passed`);
