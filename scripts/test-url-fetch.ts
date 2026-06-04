// url-fetch.ts / url-detect.ts(SSRF) のテストハーネス。
// 実行： URL_FETCH_ALLOW_LOOPBACK=1 npx tsx scripts/test-url-fetch.ts
// loopback バイパス(テスト専用)を有効化し、ローカル HTTP サーバで各分類・truncate を実測。
// SSRF ブロックは loopback 以外（private/metadata/link-local）で検証＝バイパス下でも拒否を確認。
import assert from "node:assert/strict";
import http from "node:http";
import {
  isBlockedHostname,
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateAddress,
} from "../src/lib/url-detect";
import { htmlToText, fetchUrlContent, processMessageUrls } from "../src/lib/url-fetch";

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  // ---- SSRF 純粋判定 ----
  console.log("SSRF pure");
  await t("isBlockedHostname: localhost/.local/.internal/metadata", () => {
    assert.equal(isBlockedHostname("localhost"), true);
    assert.equal(isBlockedHostname("foo.local"), true);
    assert.equal(isBlockedHostname("svc.internal"), true);
    assert.equal(isBlockedHostname("metadata.google.internal"), true);
    assert.equal(isBlockedHostname("example.com"), false);
  });
  await t("isPrivateIpv4: loopback/private/link-local/CGNAT/0", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      assert.equal(isPrivateIpv4(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1"]) {
      assert.equal(isPrivateIpv4(ip), false, ip);
    }
  });
  await t("isPrivateIpv6: ::1/ULA/link-local/mapped", () => {
    for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateIpv6(ip), true, ip);
    }
    assert.equal(isPrivateIpv6("2001:4860:4860::8888"), false);
  });
  await t("isPrivateAddress dispatch", () => {
    assert.equal(isPrivateAddress("169.254.169.254"), true);
    assert.equal(isPrivateAddress("fd00::1"), true);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
  });

  // ---- fetchUrlContent SSRF ブロック（loopback バイパス下でも拒否される対象） ----
  console.log("fetchUrlContent SSRF block");
  await t("メタデータ/private/link-local/ULA は blocked", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://10.1.2.3/x",
      "http://192.168.0.5/x",
      "http://[fd00::1]/x",
    ]) {
      const o = await fetchUrlContent(u);
      assert.equal(o.ok, false, u);
      if (!o.ok) assert.equal(o.reason, "blocked", `${u} -> ${o.reason}`);
    }
  });
  await t("Notion は取得せず auth_required", async () => {
    const o = await fetchUrlContent("https://www.notion.so/x");
    assert.equal(o.ok, false);
    if (!o.ok) assert.equal(o.reason, "auth_required");
  });

  // ---- htmlToText ----
  console.log("htmlToText");
  await t("script/style 除去・タグ除去・本文抽出", () => {
    const html = "<html><head><title>T</title><style>.a{}</style></head><body><script>x=1</script><h1>見出し</h1><p>本文です</p></body></html>";
    const txt = htmlToText(html);
    assert.match(txt, /見出し/);
    assert.match(txt, /本文です/);
    assert.doesNotMatch(txt, /x=1/);
    assert.doesNotMatch(txt, /\.a\{\}/);
  });

  // ---- ローカルサーバで分類・truncate・成功注入 ----
  console.log("fetchUrlContent classification (local server)");
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>仕様書</title></head><body><h1>仕様</h1><p>機能Aと機能B</p></body></html>");
    } else if (url === "/404") {
      res.writeHead(404); res.end("nope");
    } else if (url === "/403") {
      res.writeHead(403); res.end("forbidden");
    } else if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ a: 1 }));
    } else if (url === "/loginhtml") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ログイン<form><input type=\"password\" name=\"p\"></form></body></html>");
    } else if (url === "/redir-login") {
      res.writeHead(302, { location: "/login" }); res.end();
    } else if (url === "/login") {
      res.writeHead(200, { "content-type": "text/html" }); res.end("login page");
    } else if (url === "/redir-ok") {
      res.writeHead(302, { location: "/ok" }); res.end();
    } else if (url === "/big") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("あ".repeat(8000));
    } else {
      res.writeHead(200, { "content-type": "text/html" }); res.end("<p>default</p>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    await t("200 html → ok＋本文抽出", async () => {
      const o = await fetchUrlContent(`${base}/ok`);
      assert.equal(o.ok, true);
      if (o.ok) { assert.match(o.text, /機能Aと機能B/); assert.equal(o.title, "仕様書"); }
    });
    await t("404 → not_found", async () => {
      const o = await fetchUrlContent(`${base}/404`);
      assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "not_found");
    });
    await t("403 → forbidden", async () => {
      const o = await fetchUrlContent(`${base}/403`);
      assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "forbidden");
    });
    await t("非HTML(json) → fetch_failed", async () => {
      const o = await fetchUrlContent(`${base}/json`);
      assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "fetch_failed");
    });
    await t("login フォーム HTML → auth_required", async () => {
      const o = await fetchUrlContent(`${base}/loginhtml`);
      assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "auth_required");
    });
    await t("redirect→/login → auth_required", async () => {
      const o = await fetchUrlContent(`${base}/redir-login`);
      assert.equal(o.ok, false); if (!o.ok) assert.equal(o.reason, "auth_required");
    });
    await t("redirect→公開ページ → 追従して ok", async () => {
      const o = await fetchUrlContent(`${base}/redir-ok`);
      assert.equal(o.ok, true); if (o.ok) assert.match(o.text, /機能A/);
    });
    await t("大きな本文は MAX_TEXT(6000) で truncate", async () => {
      const o = await fetchUrlContent(`${base}/big`);
      assert.equal(o.ok, true); if (o.ok) assert.equal(o.text.length, 6000);
    });

    // ---- processMessageUrls（混在：読めるローカル＋読めない Notion） ----
    console.log("processMessageUrls");
    await t("読込✅＋読めない🔗＋ガードは読めないURLのみ＋本文注入", async () => {
      const msg = `仕様は ${base}/ok と https://www.notion.so/secret を参照`;
      const r = await processMessageUrls(msg);
      assert.ok(r.notice);
      assert.match(r.notice!, /読み込み/); // ✅ 読込
      assert.match(r.notice!, /読み取れませんでした/); // 🔗 読めない
      assert.match(r.notice!, /機能A/); // 要約抜粋
      // ガードは Notion のみ、ローカル ok は含めない
      assert.match(r.guard, /notion\.so\/secret/);
      assert.doesNotMatch(r.guard, /127\.0\.0\.1/);
      // 注入は読めた本文
      assert.match(r.injection, /機能Aと機能B/);
      assert.match(r.injection, /取得したURL本文/);
    });
    await t("URL 無し → notice null / guard,injection 空", async () => {
      const r = await processMessageUrls("URLなしのメッセージ");
      assert.equal(r.notice, null);
      assert.equal(r.guard, "");
      assert.equal(r.injection, "");
    });
  } finally {
    server.close();
  }

  console.log(`\n✅ all ${passed} tests passed`);
}

main().catch((e) => {
  console.error("TEST FAIL:", e);
  process.exit(1);
});
