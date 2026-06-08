// ensureGitBaseline の検証（npx tsx scripts/test-scaffold-baseline.ts）。
// create-next-app 後に verify.detectChanges 用の git baseline を identity 非依存で必ず作ることを確認。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitBaseline, GIT_AUTHOR_NAME } from "../src/lib/scaffold";

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), "spm-baseline-"));
  writeFileSync(join(d, "page.tsx"), "export default function Home(){return null}\n");
  return d;
}

console.log("ensureGitBaseline");

t("git 未初期化 dir に baseline commit を作る（HEAD が出来る）", () => {
  const d = mk();
  try {
    ensureGitBaseline(d);
    assert.equal(git(d, ["rev-list", "--count", "HEAD"]), "1");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

t("commit の author は -c 指定値（VM global 非依存）", () => {
  const d = mk();
  try {
    ensureGitBaseline(d);
    // global identity が別でも、-c 指定の name が commit に入る＝identity 非依存の証拠。
    assert.equal(git(d, ["log", "-1", "--format=%an"]), GIT_AUTHOR_NAME);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

t("冪等：2回呼んでも commit は1つ・例外なし", () => {
  const d = mk();
  try {
    ensureGitBaseline(d);
    ensureGitBaseline(d);
    assert.equal(git(d, ["rev-list", "--count", "HEAD"]), "1");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

t("既存 commit がある repo は skip（既存 commit を保持）", () => {
  const d = mk();
  try {
    git(d, ["init"]);
    git(d, ["-c", "user.name=pre", "-c", "user.email=pre@e.x", "add", "-A"]);
    git(d, ["-c", "user.name=pre", "-c", "user.email=pre@e.x", "commit", "-m", "pre"]);
    const before = git(d, ["rev-parse", "HEAD"]);
    ensureGitBaseline(d);
    assert.equal(git(d, ["rev-list", "--count", "HEAD"]), "1"); // 増えない
    assert.equal(git(d, ["rev-parse", "HEAD"]), before); // 既存 commit のまま
  } finally { rmSync(d, { recursive: true, force: true }); }
});

console.log(`\n✅ all ${passed} tests passed`);
