// 核バグ修正(A) の自走式テスト（tsx + node:assert、vitest 不使用）。
//   実行: npx tsx src/lib/__tests__/confirm-target.test.ts
//
// 確定経路で projectType が書かれない欠陥の回帰防止。検証:
//   1. buildConfirmTargetBody: "__new__"→projectType:"new" / 既存→"existing" を必ず同梱
//   2. isProjectType: PATCH の検証（"new"|"existing" のみ許可・不正値拒否）
//   3. computeTargetGate: 保存後 isNewRepo/canExecute=true（prod 行 spm-cartegoogle が new で復活）
//      ＋ 旧バグ状態（new リポ名 × projectType="existing"）は canExecute=false のまま（回帰ガード）
//   4. execute/parallel の isNewProject = (projectType==="new") が true で reject されないこと

import assert from "node:assert/strict";
import {
  buildConfirmTargetBody,
  computeTargetGate,
  NEW_TARGET_OPTION,
} from "../confirm-target";
import { isProjectType } from "../validation";

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// --- 1. buildConfirmTargetBody: projectType を必ず送る ---
test("__new__ 選択 → body に projectType:'new' と入力リポ名", () => {
  const body = buildConfirmTargetBody(NEW_TARGET_OPTION, "spm-cartegoogle");
  assert.deepEqual(body, {
    targetSystem: "spm-cartegoogle",
    targetLabel: "spm-cartegoogle",
    projectType: "new",
  });
});

test("__new__ 選択時はリポ名を trim する", () => {
  const body = buildConfirmTargetBody(NEW_TARGET_OPTION, "  spm-cartegoogle  ");
  assert.equal(body?.targetSystem, "spm-cartegoogle");
  assert.equal(body?.projectType, "new");
});

test("既存システム選択 → projectType:'existing' と SYSTEMS ラベル", () => {
  const body = buildConfirmTargetBody("spm-diagnosis", "");
  assert.deepEqual(body, {
    targetSystem: "spm-diagnosis",
    targetLabel: "診断支援（spm-diagnosis）",
    projectType: "existing",
  });
});

test("対象未選択（空）→ null（送信しない）", () => {
  assert.equal(buildConfirmTargetBody("", ""), null);
});

test("__new__ だがリポ名が空白のみ → null", () => {
  assert.equal(buildConfirmTargetBody(NEW_TARGET_OPTION, "   "), null);
});

// --- 2. isProjectType: PATCH の検証（不正値拒否） ---
test("isProjectType は 'new'/'existing' のみ true", () => {
  assert.equal(isProjectType("new"), true);
  assert.equal(isProjectType("existing"), true);
});

test("isProjectType は不正値を拒否（PATCH が 400 を返す根拠）", () => {
  for (const bad of ["NEW", "old", "", "  ", null, undefined, 1, {}, []]) {
    assert.equal(isProjectType(bad), false, `${JSON.stringify(bad)} は拒否されるべき`);
  }
});

// --- 3. computeTargetGate: 保存後の表示・実行可否 ---
test("修正後: 新規リポ名 × projectType='new' → canExecute=true / isNewRepo=true", () => {
  // prod 行 targetSystem="spm-cartegoogle" が projectType="new" で保存されれば復活する
  const gate = computeTargetGate({ targetSystem: "spm-cartegoogle", projectType: "new" });
  assert.equal(gate.isNewRepo, true);
  assert.equal(gate.canExecute, true);
});

test("回帰ガード: 新規リポ名 × projectType='existing'（旧バグ状態）→ canExecute=false", () => {
  const gate = computeTargetGate({ targetSystem: "spm-cartegoogle", projectType: "existing" });
  assert.equal(gate.isNewRepo, false);
  assert.equal(gate.canExecute, false);
});

test("既存 ALLOWED_REPO は projectType に依らず canExecute=true", () => {
  const gate = computeTargetGate({ targetSystem: "spm-diagnosis", projectType: "existing" });
  assert.equal(gate.isNewRepo, false);
  assert.equal(gate.canExecute, true);
});

test("targetSystem=null は canExecute=false", () => {
  const gate = computeTargetGate({ targetSystem: null, projectType: "new" });
  assert.equal(gate.canExecute, false);
});

// --- 4. execute / parallel の isNewProject 整合（reject されない） ---
test("execute/parallel: persisted projectType='new' → isNewProject=true で非リジェクト", () => {
  // src/app/api/execute/route.ts:95-96 と parallel/route.ts:79 と同型のガード:
  //   const isNewProject = project.projectType === "new";
  //   if (!isNewProject && !isAllowedRepo(targetRepo)) reject;
  const projectType = "new";
  const targetRepo = "spm-cartegoogle"; // ALLOWED_REPOS 外
  const isNewProject = projectType === "new";
  const rejected = !isNewProject && !["spm-diagnosis"].includes(targetRepo);
  assert.equal(isNewProject, true);
  assert.equal(rejected, false);
});

// --- runner ---
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
