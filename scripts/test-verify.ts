// verify.ts のテストハーネス（npx tsx scripts/test-verify.ts）。
// 純粋寄りの detectBoilerplate / parseVerifyVerdict / buildCriticPrompt を検証。
// detectBoilerplate は一時ディレクトリに合成 page.tsx を置いて実測。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { detectBoilerplate, parseVerifyVerdict, buildCriticPrompt } from "../src/lib/verify";

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function tmpProject(pageContent: string | null, rel = "app/page.tsx"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
  if (pageContent != null) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, pageContent, "utf-8");
  }
  return dir;
}

const TEMPLATE = `import Image from "next/image";
export default function Home() {
  return (<main><ol><li>Get started by editing <code>app/page.tsx</code>.</li>
  <li>Save and see your changes instantly.</li></ol>
  <a href="https://vercel.com">Deploy now</a></main>);
}`;

const REAL = `"use client";
import { useState } from "react";
import { FloorMap } from "@/components/FloorMap";
export default function Home() {
  const [pattern, setPattern] = useState<"A" | "B">("A");
  return (<main>
    <h1>動物病院レイアウト</h1>
    <button onClick={() => setPattern("A")}>パターンA</button>
    <button onClick={() => setPattern("B")}>パターンB</button>
    <FloorMap pattern={pattern} catExam dogExam treatmentOR reception acousticPath />
  </main>);
}`;

console.log("detectBoilerplate");
t("Next 初期テンプレ → isBoilerplate true", () => {
  const dir = tmpProject(TEMPLATE);
  try {
    const r = detectBoilerplate(dir);
    assert.equal(r.isBoilerplate, true);
    assert.match(r.reasons.join(" "), /初期テンプレ/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
t("実装済みページ → isBoilerplate false", () => {
  const dir = tmpProject(REAL);
  try {
    assert.equal(detectBoilerplate(dir).isBoilerplate, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
t("未実装マーカー残存 → true", () => {
  const dir = tmpProject(`export default function Home(){return <main>ここに実装してください（TODO: implement）の充実した説明文をたくさん並べてダミーで長くする</main>}`);
  try {
    const r = detectBoilerplate(dir);
    assert.equal(r.isBoilerplate, true);
    assert.match(r.reasons.join(" "), /未実装マーカー/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
t("極端に短いページ → true", () => {
  const dir = tmpProject(`export default()=> <div/>;`);
  try {
    assert.equal(detectBoilerplate(dir).isBoilerplate, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
t("page が存在しない → false（対象外・detectChanges に委譲）", () => {
  const dir = tmpProject(null);
  try {
    assert.equal(detectBoilerplate(dir).isBoilerplate, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
t("src/app/page.tsx も検出する", () => {
  const dir = tmpProject(TEMPLATE, "src/app/page.tsx");
  try {
    assert.equal(detectBoilerplate(dir).isBoilerplate, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log("parseVerifyVerdict");
t("pass マーカー", () => {
  const v = parseVerifyVerdict('レビュー結果...\n[[VERIFY]] {"verdict":"pass","reasons":[]}');
  assert.equal(v.verdict, "pass");
});
t("fail マーカー＋理由", () => {
  const v = parseVerifyVerdict('[[VERIFY]] {"verdict":"fail","reasons":["page.tsx 未実装","要件Xが未充足"]}');
  assert.equal(v.verdict, "fail");
  assert.equal(v.reasons.length, 2);
});
t("マーカー無し → fail（安全側）", () => {
  assert.equal(parseVerifyVerdict("ただのレビュー文。マーカーなし。").verdict, "fail");
});
t("プレースホルダ理由は除外", () => {
  const v = parseVerifyVerdict('[[VERIFY]] {"verdict":"fail","reasons":["<具体的な問題>","本物の問題"]}');
  assert.deepEqual(v.reasons, ["本物の問題"]);
});

console.log("buildCriticPrompt");
t("要件/スプリント/VERIFY 指示を含む", () => {
  const p = buildCriticPrompt("要件本文XYZ", "スプリント計画ABC", "/tmp/proj");
  assert.match(p, /要件本文XYZ/);
  assert.match(p, /スプリント計画ABC/);
  assert.match(p, /\[\[VERIFY\]\]/);
  assert.match(p, /初期テンプレ/);
});

console.log(`\n✅ all ${passed} tests passed`);
