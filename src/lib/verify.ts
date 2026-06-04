// 検証ゲート（Phase D）の検証ロジック。parse/prompt/boilerplate は純粋寄り、build/changes は cwd 上で実行。
// done/log は claude-code-runner と同じ命名（/tmp/claude-done-<id> / claude-log-<id>）にし、
// parallel-tick の inspectExec(doneFile, pid) でそのまま結果判定できるようにする。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync, readFileSync } from "node:fs";

function loginShell(): string {
  return process.env.SHELL || "/bin/bash";
}
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ① 変更検知：parts が成果物を生んだか。git の未コミット変更 or 初回以降の commit があれば changed。
// create-next-app は git init＋初回 commit 済み。parts(claude) は通常コミットしないので未コミット差分で出る。
// 無変更（changed=false）は fail 寄り（「実装が産まれていない」赤信号）。
export function detectChanges(cwd: string): { changed: boolean; summary: string } {
  try {
    const porcelain = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 15000 }).trim();
    let commits = 0;
    try {
      commits = Number(execSync("git rev-list --count HEAD", { cwd, encoding: "utf-8", timeout: 15000 }).trim()) || 0;
    } catch {
      /* HEAD 無し（commit ゼロ）は 0 のまま */
    }
    const changed = porcelain.length > 0 || commits > 1;
    return {
      changed,
      summary: porcelain
        ? `未コミット変更あり:\n${porcelain.slice(0, 800)}`
        : commits > 1
          ? `commit ${commits} 件（初回 scaffold 以降の変更あり）`
          : "変更が検出できません（実装が産まれていない可能性）",
    };
  } catch (e) {
    return { changed: false, summary: `git status 実行失敗: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ①.5 ボイラープレート検知（決定論）：メインページが Next 初期テンプレのまま／未実装マーカー残存なら
// 「実装されていない」と判定。spm-clinic-layout で page.tsx がボイラープレートのまま完了した欠陥への対策。
const MAIN_PAGE_CANDIDATES = [
  "app/page.tsx",
  "src/app/page.tsx",
  "app/page.js",
  "src/app/page.js",
  "pages/index.tsx",
  "pages/index.js",
  "src/pages/index.tsx",
];
// create-next-app 初期テンプレに固有の語句（通常の実装では消える）。
const TEMPLATE_MARKERS = [
  "Get started by editing",
  "Save and see your changes",
  "Deploy now",
  "Read our docs",
  "nextjs.org/icon",
  "vercel.svg",
  "next.svg",
  "examples/with-app-dir",
  "Learn Next.js",
];
// 実装途中で残りがちな未実装マーカー（メインページに限定して誤検知を抑える）。
const UNIMPL_MARKERS = ["実装してください", "ここに実装", "未実装", "TODO: implement", "PLACEHOLDER"];

export function detectBoilerplate(cwd: string): { isBoilerplate: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let mainPage: string | null = null;
  let mainPagePath = "";
  for (const rel of MAIN_PAGE_CANDIDATES) {
    const abs = path.join(cwd, rel);
    if (existsSync(abs)) {
      try {
        mainPage = readFileSync(abs, "utf-8");
        mainPagePath = rel;
        break;
      } catch {
        /* 読めない候補はスキップ */
      }
    }
  }
  // メインページが見つからない＝Next アプリでない可能性。ここでは boilerplate 判定の対象外
  // （変更検知 detectChanges 側で「実装なし」を拾う）。誤検知を避けるため false。
  if (mainPage == null) return { isBoilerplate: false, reasons: [] };

  const hitTemplate = TEMPLATE_MARKERS.filter((m) => mainPage!.includes(m));
  if (hitTemplate.length > 0) {
    reasons.push(`${mainPagePath} が Next 初期テンプレのまま（検出: ${hitTemplate.slice(0, 3).join(" / ")}）`);
  }
  const hitUnimpl = UNIMPL_MARKERS.filter((m) => mainPage!.includes(m));
  if (hitUnimpl.length > 0) {
    reasons.push(`${mainPagePath} に未実装マーカー残存（${hitUnimpl.slice(0, 3).join(" / ")}）`);
  }
  // メインページが極端に短い（実質空＝デフォルトの素通し）も赤信号。
  const meaningful = mainPage.replace(/\s+/g, "").length;
  if (hitTemplate.length === 0 && hitUnimpl.length === 0 && meaningful < 120) {
    reasons.push(`${mainPagePath} の実装が極端に小さい（実質 ${meaningful} 文字）`);
  }
  return { isBoilerplate: reasons.length > 0, reasons };
}

// ② ビルド検証：npm ci && npm run build。detached で起動し inspectExec が読める done/log を返す。
export function runBuildCheck(cwd: string): { pid: number; doneFile: string; logFile: string } {
  const id = randomUUID();
  const doneFile = path.join(os.tmpdir(), `claude-done-${id}`);
  const logFile = path.join(os.tmpdir(), `claude-log-${id}`);
  const cmd =
    `cd ${shq(cwd)} && (npm ci && npm run build) > ${shq(logFile)} 2>&1; echo $? > ${shq(doneFile)}`;
  const proc = spawn(loginShell(), ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  proc.on("error", (err) => {
    void fs.writeFile(logFile, `[build spawn失敗] ${err.message}`, "utf-8").catch(() => {});
    void fs.writeFile(doneFile, "127", "utf-8").catch(() => {});
  });
  proc.unref();
  return { pid: typeof proc.pid === "number" ? proc.pid : -1, doneFile, logFile };
}

// ③ critic claude へ渡すプロンプト（要件＋スプリント＋cwd を読ませ、最後に厳密1行 [[VERIFY]] を出させる）。
export function buildCriticPrompt(requirements: string, sprint: string, cwd: string): string {
  return (
    `# 成果物レビュー（批評エージェント）\n` +
    `あなたは別の AI が実装した成果物を、元の要件・計画に照らして厳しくレビューする批評者です。\n` +
    `対象ディレクトリ: ${cwd}\n（このディレクトリのファイルを読んで実装状況を確認してください）\n\n` +
    `## 元の要件\n${(requirements || "(要件ドキュメントなし)").slice(0, 4000)}\n\n` +
    `## スプリント計画\n${(sprint || "(スプリント計画なし)").slice(0, 4000)}\n\n` +
    `## 点検観点（赤信号）\n` +
    `- placeholder / TODO / "実装してください" の取り残し\n` +
    `- 要件の未充足・未着手\n` +
    `- メインページが create-next-app の初期テンプレのまま\n` +
    `- 未解決の [[ASK_HUMAN]] が残っている\n` +
    `- 「未着手」「推測で実装」などの記述\n\n` +
    `## 出力（厳守）\n` +
    `レビュー後、出力の最後に **次の1行だけ** を独立行で出してください：\n` +
    `[[VERIFY]] {"verdict":"pass","reasons":[]}  ← 問題なし\n` +
    `または\n` +
    `[[VERIFY]] {"verdict":"fail","reasons":["具体的な問題1","問題2"]}\n` +
    `- verdict は必須("pass"/"fail")。reasons は fail の具体的理由（プレースホルダ <...> は書かない）。\n` +
    `- JSON は1行・ダブルクオート・改行なし。`
  );
}

// [[VERIFY]] マーカーの厳格パース。parse 失敗/不正は fail（安全側）。reasons の <...> プレースホルダは除外。
const PLACEHOLDER = /^\s*<.*>\s*$/;
export function parseVerifyVerdict(log: string): { verdict: "pass" | "fail"; reasons: string[] } {
  let found: { verdict: "pass" | "fail"; reasons: string[] } | null = null;
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^\s*\[\[VERIFY\]\]\s*(\{.*\})\s*$/);
    if (!m) continue;
    try {
      const o = JSON.parse(m[1]) as { verdict?: unknown; reasons?: unknown };
      if (o.verdict !== "pass" && o.verdict !== "fail") continue;
      const reasons = Array.isArray(o.reasons)
        ? o.reasons.filter((r): r is string => typeof r === "string" && !PLACEHOLDER.test(r.trim()))
        : [];
      found = { verdict: o.verdict, reasons };
    } catch {
      // JSON パース失敗は通常出力扱い（無視して次行）
    }
  }
  // マーカー未検出/全て不正 → fail 安全側
  return found ?? { verdict: "fail", reasons: ["[[VERIFY]] マーカーを検出できませんでした（critic 出力が不正/未完）"] };
}
