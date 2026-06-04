// slack-user.ts のテスト（npx tsx scripts/test-slack-user.ts）。
// resolveSlackUser を users.info モック fetcher で検証（ネットワーク無し）。
import assert from "node:assert/strict";
import { resolveSlackUser, type UsersInfoFetcher } from "../src/lib/slack-user";

let passed = 0;
async function t(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const okFetcher: UsersInfoFetcher = async () => ({
  ok: true,
  user: { real_name: "石井 豪", profile: { display_name: "ごう" } },
});
const okNoDisplay: UsersInfoFetcher = async () => ({ ok: true, user: { real_name: "水田暉人", profile: {} } });
const missingScope: UsersInfoFetcher = async () => ({ ok: false, error: "missing_scope" });
const notFound: UsersInfoFetcher = async () => ({ ok: false, error: "user_not_found" });
const throwing: UsersInfoFetcher = async () => { throw new Error("network"); };
let called = 0;
const countingFetcher: UsersInfoFetcher = async () => { called++; return { ok: true, user: { profile: { display_name: "x" } } }; };

async function main() {
  console.log("resolveSlackUser");
  await t("形式不正は invalid_format（fetcher 呼ばない）", async () => {
    called = 0;
    const r = await resolveSlackUser("not-a-slack-id", countingFetcher);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_format");
    assert.equal(called, 0);
  });
  await t("実在ユーザー解決 → ok＋display_name", async () => {
    const r = await resolveSlackUser("U0AMRAQDW65", okFetcher);
    assert.equal(r.ok, true);
    assert.equal(r.displayName, "ごう");
    assert.equal(r.realName, "石井 豪");
  });
  await t("display_name 無し → real_name にフォールバック", async () => {
    const r = await resolveSlackUser("U0ANZRQGQC8", okNoDisplay);
    assert.equal(r.ok, true);
    assert.equal(r.displayName, "水田暉人");
  });
  await t("missing_scope", async () => {
    const r = await resolveSlackUser("U0AMRAQDW65", missingScope);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_scope");
  });
  await t("user_not_found", async () => {
    const r = await resolveSlackUser("U0000000000", notFound);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "user_not_found");
  });
  await t("fetcher 例外 → fetch_failed", async () => {
    const r = await resolveSlackUser("U0AMRAQDW65", throwing);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "fetch_failed");
  });

  console.log(`\n✅ all ${passed} tests passed`);
}

main().catch((e) => { console.error("TEST FAIL:", e); process.exit(1); });
