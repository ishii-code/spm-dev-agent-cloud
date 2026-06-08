import { spawn, execFileSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";

export interface ScaffoldResult {
  ok: boolean;
  exitCode: number | null;
  tail: string; // 出力末尾（最大 8KB）
  error?: string; // spawn 自体が失敗したとき（ENOENT 等）のメッセージ
}

// git baseline 用の commit identity。-c で明示指定するため VM global の git config に依存しない。
// 環境変数で上書き可（既定は VM global に合わせた値）。
export const GIT_AUTHOR_NAME = process.env.SPM_GIT_AUTHOR_NAME?.trim() || "spm-dev-agent";
export const GIT_AUTHOR_EMAIL = process.env.SPM_GIT_AUTHOR_EMAIL?.trim() || "dev-agent@peco-japan.com";

// create-next-app は git identity 未設定だと初回 commit に失敗し git init を巻き戻す（.git が残らない）。
// verify.ts の detectChanges は「初回 scaffold が git baseline 済み」を前提とするため、ここで明示的に
// baseline commit を作る。-c で identity を直接渡すので VM global の git config が消えても/巻き戻されても
// 必ず baseline が残る（identity 非依存の恒久化）。既に commit があれば（identity 在りで create-next-app が
// commit 済みのケース）何もしない＝冪等。失敗しても scaffold 自体は止めない（tail にだけ記録）。
export function ensureGitBaseline(cwd: string, log: (s: string) => void = () => {}): void {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  try {
    try {
      git(["rev-parse", "--verify", "HEAD"]); // commit が既にある？
      log("[scaffold] git baseline 済（既存 commit あり）\n");
      return;
    } catch {
      /* HEAD 無し（commit ゼロ）→ baseline を作成する */
    }
    try {
      git(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      git(["init"]); // .git が無ければ初期化
    }
    git(["add", "-A"]);
    git([
      "-c", `user.name=${GIT_AUTHOR_NAME}`,
      "-c", `user.email=${GIT_AUTHOR_EMAIL}`,
      "commit", "-m", "scaffold baseline (spm-dev-agent)",
    ]);
    log("[scaffold] git baseline commit を作成\n");
  } catch (e) {
    log(`[scaffold] git baseline 失敗（verify の変更検知に影響の可能性）: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

const CREATE_NEXT_APP_ARGS = [
  "create-next-app@latest",
  ".",
  "--typescript",
  "--tailwind",
  "--eslint",
  "--app",
  "--src-dir",
  "--import-alias",
  "@/*",
  "--use-npm",
  "--yes",
];

// 指定した恒久ディレクトリ（VM worker 上）で create-next-app を実行し
// Next.js プロジェクトを生成する。出力末尾（最大 8KB）を保持して返す。
//
// このモジュールは Slack 非依存に保つ（呼び出し側 worker が SlackTarget 経由で
// 成功/失敗を通知する）。Cloud Run の ephemeral FS ではなく、VM の恒久ディレクトリ
// 上で実行されることを前提とする（生成先の妥当性は repos.newProjectsRoot() で担保）。
export async function scaffoldNextApp(
  cwd: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<ScaffoldResult> {
  await fsPromises.mkdir(cwd, { recursive: true });

  return await new Promise<ScaffoldResult>((resolve) => {
    let tail = "";
    const append = (s: string) => {
      tail = (tail + s).slice(-8000);
    };

    const proc = spawn("npx", CREATE_NEXT_APP_ARGS, {
      cwd,
      env: {
        ...process.env,
        // VM(Linux) の PATH を尊重。未設定時のみ最小フォールバック。
        // （macOS 固定パスは使わない＝旧 EACCES 事象の再発防止）
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) => {
      const line = d.toString();
      append(line);
      opts.onLog?.(line);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString();
      append(line);
      opts.onLog?.(line);
    });
    proc.on("close", (code) => {
      // create-next-app 成功時のみ、verify の detectChanges 用に git baseline を恒久化する。
      if (code === 0) {
        ensureGitBaseline(cwd, (s) => {
          append(s);
          opts.onLog?.(s);
        });
      }
      resolve({ ok: code === 0, exitCode: code, tail });
    });
    proc.on("error", (err: Error) => {
      resolve({ ok: false, exitCode: null, tail, error: err.message });
    });
  });
}
