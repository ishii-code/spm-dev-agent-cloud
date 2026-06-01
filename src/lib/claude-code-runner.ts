import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { waitForSlackApproval, waitForSlackChoice } from "./slack-approval";

// =============================================================================
// 実行環境の解決（macOS / Linux 両対応）
// 旧実装は claude バイナリ・PATH・シェルを macOS 決め打ち
// （/Users/ishiitakeshi/.npm-global/bin/claude, zsh, nohup）にしていたため、
// Linux VM では存在せず `spawn nohup EACCES` などで起動できなかった。
// 以下で claude バイナリ・PATH・シェルを動的に解決する。
// =============================================================================

const IS_DARWIN = process.platform === "darwin";

function defaultHome(): string {
  return process.env.HOME ?? (IS_DARWIN ? "/Users/ishiitakeshi" : "/home/ishiitakeshi");
}

// 実行時 PATH。主要 bin ディレクトリを明示的に並べ、既存の process.env.PATH も温存する。
function runtimePath(): string {
  const home = defaultHome();
  const dirs = IS_DARWIN
    ? [`${home}/.npm-global/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    : ["/usr/local/bin", "/usr/bin", "/bin", `${home}/.npm-global/bin`];
  const fromEnv = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  return Array.from(new Set([...dirs, ...fromEnv]))
    .filter(Boolean)
    .join(path.delimiter);
}

// 起動シェル。Linux VM に zsh が無いケースに対応して bash を使う。
function loginShell(): string {
  return IS_DARWIN ? "/bin/zsh" : "/bin/bash";
}

// claude バイナリの絶対パスを解決する。
//   1) 環境変数 CLAUDE_BIN（存在チェック付き）
//   2) which / where claude（runtimePath を使って検出）
//   3) いずれも失敗なら明示的にエラー
// 結果はプロセス内でキャッシュする。
let cachedClaudeBin: string | null = null;
function resolveClaudeBin(): string {
  if (cachedClaudeBin) return cachedClaudeBin;

  const fromEnv = process.env.CLAUDE_BIN?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `CLAUDE_BIN="${fromEnv}" が指すファイルが存在しません（platform=${process.platform}）`,
      );
    }
    cachedClaudeBin = fromEnv;
    return fromEnv;
  }

  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(locator, ["claude"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: runtimePath() },
    })
      .split(/\r?\n/)[0]
      ?.trim();
    if (found && existsSync(found)) {
      cachedClaudeBin = found;
      return found;
    }
  } catch {
    // 検出失敗 → 下の throw へフォールスルー
  }

  throw new Error(
    `claude バイナリを解決できません。環境変数 CLAUDE_BIN を設定するか、` +
      `PATH（${runtimePath()}）に claude を配置してください（platform=${process.platform}）`,
  );
}

const APPROVAL_PATTERNS = [
  /Do you want to proceed/i,
  /Would you like to/i,
  /Are you sure/i,
  /Proceed\?/i,
  /continue\?/i,
];

function detectChoices(text: string): string[] | null {
  const lines = text.split("\n");
  const choiceLines = lines.filter((l) => /^\s*[❯➤>]?\s*\d+\.\s+\S/.test(l));
  if (choiceLines.length >= 2) {
    return choiceLines.map((l) => l.replace(/^\s*[❯➤>]?\s*\d+\.\s+/, "").trim());
  }
  return null;
}

function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>]/g, "");
}

export interface RunResult {
  success: boolean;
  output: string;
  exitCode?: number | null;
}

export async function runClaudeCode(
  prompt: string,
  workingDir: string,
  projectTitle: string,
  projectId: string,
  slackThreadTs: string | undefined,
  onOutput: (line: string) => void,
): Promise<RunResult> {
  void projectId;

  const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}.txt`);
  await fs.writeFile(tmpFile, prompt, "utf-8");

  try {
    const pty = await import("node-pty");
    return await runWithPty(pty, tmpFile, workingDir, projectTitle, slackThreadTs, onOutput);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onOutput(`⚠️ PTY起動失敗（${message}）。exec方式で実行します。`);
    return await runWithExec(tmpFile, workingDir, onOutput);
  }
}

async function runWithPty(
  pty: typeof import("node-pty"),
  tmpFile: string,
  workingDir: string,
  projectTitle: string,
  slackThreadTs: string | undefined,
  onOutput: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    let buffer = "";
    let isHandlingPrompt = false;
    let outputTimer: NodeJS.Timeout | null = null;

    const claudeBin = resolveClaudeBin();
    const ptyProcess = pty.spawn(
      loginShell(),
      ["-c", `cat ${shQuote(tmpFile)} | ${shQuote(claudeBin)} --dangerously-skip-permissions`],
      {
        name: "xterm-color",
        cols: 220,
        rows: 50,
        cwd: workingDir,
        env: {
          ...process.env,
          PATH: runtimePath(),
          HOME: defaultHome(),
          TERM: "xterm-256color",
        } as Record<string, string>,
      },
    );

    ptyProcess.onData((data: string) => {
      output += data;
      buffer += data;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines
        .map((l) => stripAnsi(l).trim())
        .filter((l) => l.length > 0)
        .forEach((l) => onOutput(l));

      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = setTimeout(async () => {
        if (isHandlingPrompt) return;

        const cleanText = stripAnsi(output.slice(-3000));

        const choices = detectChoices(cleanText);
        if (choices && choices.length >= 2) {
          isHandlingPrompt = true;
          onOutput(`⏳ Slack選択待ち中...`);

          const selected = await waitForSlackChoice(
            projectTitle,
            "Claude Codeから選択を求められています",
            choices,
            slackThreadTs,
            (elapsed) => onOutput(`⏳ Slack選択待ち... ${elapsed}秒`),
          );

          onOutput(`✅ ${selected}番を選択しました`);
          ptyProcess.write(`${selected}\r`);
          isHandlingPrompt = false;
          return;
        }

        const needsApproval = APPROVAL_PATTERNS.some((p) => p.test(cleanText));
        if (needsApproval) {
          isHandlingPrompt = true;
          onOutput(`⏳ Slack承認待ち中...`);

          const result = await waitForSlackApproval(
            projectTitle,
            "Claude Codeの実行承認が必要です",
            slackThreadTs,
            (elapsed) => onOutput(`⏳ Slack承認待ち... ${elapsed}秒`),
          );

          if (result === "approved") {
            onOutput(`✅ Slack承認済み。続行します。`);
            ptyProcess.write("y\r");
          } else {
            onOutput(`❌ Slack却下。実装を中止します。`);
            ptyProcess.write("n\r");
          }
          isHandlingPrompt = false;
        }
      }, 3000);
    });

    ptyProcess.onExit(async ({ exitCode }: { exitCode: number }) => {
      if (outputTimer) clearTimeout(outputTimer);
      await fs.unlink(tmpFile).catch(() => {});
      resolve({ success: exitCode === 0, exitCode, output });
    });
  });
}

const EXEC_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function runWithExec(
  tmpFile: string,
  workingDir: string,
  onOutput: (line: string) => void,
): Promise<RunResult> {
  const { spawn } = await import("child_process");
  let output = "";

  const claudeBin = resolveClaudeBin();
  const shell = loginShell();
  const proc = spawn(
    shell,
    [
      "-c",
      `${shQuote(claudeBin)} --dangerously-skip-permissions < ${shQuote(tmpFile)}`,
    ],
    {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: runtimePath(),
        TERM: "xterm-256color",
      },
    },
  );
  proc.on("error", (err: Error) => {
    onOutput(
      `spawn失敗: shell=${shell} claudeBin=${claudeBin} PATH=${runtimePath()} :: ${err.message}`,
    );
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    output += text;
    text.split("\n").filter((l) => l.trim()).forEach(onOutput);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    text.split("\n").filter((l) => l.trim()).forEach(onOutput);
  });

  let exitCode: number | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new Error("タイムアウト（3時間）"));
      }, EXEC_TIMEOUT_MS);

      proc.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        exitCode = code ?? null;
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Claude Code終了コード: ${code}`));
        }
      });
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      });
    });

    await fs.unlink(tmpFile).catch(() => {});
    return { success: true, output, exitCode };
  } catch (e) {
    await fs.unlink(tmpFile).catch(() => {});
    const message = e instanceof Error ? e.message : String(e);
    onOutput(`エラー: ${message}`);
    return { success: false, output, exitCode: exitCode ?? 1 };
  }
}

// =============================================================================
// ノンブロッキング・ステートマシン用 API（runClaudeCode とは独立）
// =============================================================================

export interface SpawnedProc {
  pid: number;
  promptFile: string;
  doneFile: string;
  logFile: string;
}

export type CheckClaudeCodeResult = "running" | "success" | "failed";

// detached でClaude Codeを起動して即座に返す。プロセスは親と切り離され、
// 親（Node サーバー）が再起動しても生き続ける可能性がある。
// 完了時には doneFile に終了コードが書かれる。
//
// 孤児プロセス対策: shell の argv 先頭に SPM_RUN_ID=<id> SPM_PROJECT=<projectId> を
// 環境変数代入として付けて起動するため `ps -eo pid,command | grep SPM_RUN_ID` で
// 全関連プロセスを特定可能。projectId を省略した場合は "unknown" になる。
export async function startClaudeCodeDetached(
  prompt: string,
  workingDir: string,
  label: string,
  projectId: string = "unknown",
): Promise<SpawnedProc> {
  void label;

  const id = randomUUID();
  const tmp = os.tmpdir();
  const promptFile = path.join(tmp, `claude-prompt-${id}.txt`);
  const doneFile = path.join(tmp, `claude-done-${id}`);
  const logFile = path.join(tmp, `claude-log-${id}`);

  await fs.writeFile(promptFile, prompt, "utf-8");

  const { spawn } = await import("child_process");

  // claude バイナリ・シェル・PATH を動的解決（macOS / Linux 両対応）。
  // resolveClaudeBin() が解決できなければここで throw → 呼び出し元 advanceApproved の
  // catch が executionLog にエラー詳細を保存する。
  const claudeBin = resolveClaudeBin();
  const shell = loginShell();
  const execPath = runtimePath();

  // detached:true（setsid 相当）で親から完全に切り離す。nohup は使わない
  // （Linux VM で nohup が PATH に無い／実行不可だと `spawn nohup EACCES` で
  //   親プロセスごと落ちるため、移植性の高い detached に統一）。
  // shell コマンド先頭のマーカー（環境変数代入）で ps から発見可能。
  // 末尾の `echo $? > doneFile` で終了コードを記録する。
  const marker = `SPM_RUN_ID=${id} SPM_PROJECT=${projectId}`;
  const shellCmd =
    `${marker} ${shQuote(claudeBin)} --dangerously-skip-permissions ` +
    `< ${shQuote(promptFile)} > ${shQuote(logFile)} 2>&1; ` +
    `echo $? > ${shQuote(doneFile)}`;

  const spawnDesc = `shell=${shell} claudeBin=${claudeBin} cwd=${workingDir} PATH=${execPath}`;

  let proc: import("child_process").ChildProcess;
  try {
    proc = spawn(shell, ["-c", shellCmd], {
      cwd: workingDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: execPath,
        TERM: "xterm-256color",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail = `[spawn失敗] ${spawnDesc}\n${msg}`;
    console.error(`[RUNNER] ${detail}`);
    await fs.writeFile(logFile, detail, "utf-8").catch(() => {});
    throw new Error(detail);
  }

  // detached プロセスの非同期エラー（EACCES/ENOENT 等）で親が落ちないよう必ず捕捉する。
  // 失敗内容を logFile に残し、doneFile に非ゼロを書いて checkClaudeCode が 'failed' を
  // 返せるようにする（doneFile が無いと 'running' のまま無限待ちになるため）。
  proc.on("error", (err: Error) => {
    const detail = `[spawn失敗:async] ${spawnDesc}\n${err.message}`;
    console.error(`[RUNNER] ${detail}`);
    void fs.writeFile(logFile, detail, "utf-8").catch(() => {});
    void fs.writeFile(doneFile, "127", "utf-8").catch(() => {});
  });

  if (typeof proc.pid !== "number") {
    const detail = `[spawn失敗] pid is undefined :: ${spawnDesc}`;
    console.error(`[RUNNER] ${detail}`);
    await fs.writeFile(logFile, detail, "utf-8").catch(() => {});
    throw new Error(detail);
  }
  proc.unref();

  console.log(`[RUNNER] spawned claude pid=${proc.pid} ${spawnDesc}`);

  return { pid: proc.pid, promptFile, doneFile, logFile };
}

// プロセスの生死と結果を「確認するだけ」。ブロックしない。
//   - doneFile が存在 → 中身を読んで終了コードを判定（0:success / 他:failed）
//   - doneFile 無し ＆ pid 生存（kill(pid, 0) 成功）→ 'running'
//   - doneFile 無し ＆ pid 死亡 → 'failed'（異常終了）
export function checkClaudeCode(proc: {
  pid: number | null;
  doneFile: string;
}): CheckClaudeCodeResult {
  if (existsSync(proc.doneFile)) {
    try {
      const raw = readFileSync(proc.doneFile, "utf-8").trim();
      const code = Number.parseInt(raw, 10);
      if (!Number.isNaN(code) && code === 0) return "success";
      return "failed";
    } catch {
      return "failed";
    }
  }
  if (proc.pid == null) return "failed";
  try {
    process.kill(proc.pid, 0);
    return "running";
  } catch {
    return "failed";
  }
}

// 安全な POSIX シェル引用化。シングルクオートで囲み、内部のシングルクオートを escape。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

