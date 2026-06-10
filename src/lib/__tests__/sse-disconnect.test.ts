// SSE 切断時の挙動テスト（tsx + node:assert、vitest 不使用）。
//   実行: npx tsx src/lib/__tests__/sse-disconnect.test.ts
//
// ③のバグ修正の核心を検証する:
//   クライアント切断後も produce() が巻き戻らず「末尾の status 更新」まで到達すること。
//   （旧実装は send() の enqueue 例外が produce を巻き戻し、最終 status を取りこぼしていた）
//
// 相対 import のみ。SSEChunk は型のみ（tsx/esbuild が import type を実行時に削除）。

import assert from "node:assert/strict";
import { createSSEStream } from "../sse";
import type { SSEChunk } from "../../types";

// 確実に有効な SSEChunk（sse.ts 自身が使う error バリアント）。
const ping = (): SSEChunk => ({ type: "error", data: { message: "ping" } });

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// ③核心：切断(cancel)後も produce は末尾まで走り切る
// ---------------------------------------------------------------------------
test("切断(cancel)後も produce は末尾の status 更新まで到達する", async () => {
  let reachedEnd = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));

  const res = createSSEStream(async (send) => {
    send(ping()); // 接続中の送信
    await gate; // ここでクライアント切断を起こす
    send(ping()); // 切断後の送信：no-op 化されるべき（throw して produce を巻き戻さない）
    reachedEnd = true; // ← 末尾の prisma.session.update({status}) 相当
  });

  const reader = res.body!.getReader();
  await reader.read(); // 最初のチャンクを受信
  await reader.cancel(); // クライアント切断 → ReadableStream の cancel() → closed=true
  release(); // produce を継続させる
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(reachedEnd, true, "produce が末尾まで到達していない（status 取りこぼし）");
});

// ---------------------------------------------------------------------------
// 回帰：正常系では全チャンク配信後にストリームが閉じる
// ---------------------------------------------------------------------------
test("正常系：チャンク配信後に done で閉じる", async () => {
  const res = createSSEStream(async (send) => {
    send(ping());
    send(ping());
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let payload = "";
  let closedNormally = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      closedNormally = true;
      break;
    }
    if (value) payload += dec.decode(value);
  }
  assert.equal(closedNormally, true);
  // 2 回の send が data: 行として届いている
  assert.equal(payload.match(/data: /g)?.length, 2);
});

// ---------------------------------------------------------------------------
// 回帰：produce 例外時は error チャンクを送って正常に閉じる
// ---------------------------------------------------------------------------
test("produce 例外時は error チャンクを送って閉じる", async () => {
  const res = createSSEStream(async (send) => {
    send(ping());
    throw new Error("boom");
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += dec.decode(value);
  }
  assert.match(text, /"type":"error"/);
  assert.match(text, /boom/);
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
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
}

void main();
