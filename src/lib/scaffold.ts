import { spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";

export interface ScaffoldResult {
  ok: boolean;
  exitCode: number | null;
  tail: string; // 出力末尾（最大 8KB）
  error?: string; // spawn 自体が失敗したとき（ENOENT 等）のメッセージ
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
      resolve({ ok: code === 0, exitCode: code, tail });
    });
    proc.on("error", (err: Error) => {
      resolve({ ok: false, exitCode: null, tail, error: err.message });
    });
  });
}
