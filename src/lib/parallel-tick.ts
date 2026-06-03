import { promises as fsp, constants as fsConstants } from "fs";
import path from "path";
import { prisma } from "./prisma";
import { projectsRoot } from "./repos";
import {
  startClaudeCodeDetached,
  checkClaudeCode,
} from "./claude-code-runner";
import {
  checkReactionOnce,
  postSlackTo,
  openDmChannel,
  slackConfigured,
  approvalChannel,
} from "./slack-notifier";
import { scaffoldNextApp } from "./scaffold";
import { spawn } from "node:child_process";

// 新規プロジェクトの scaffold 成功後に起動する VS Code（ヘッドレス VM では best-effort）。
const CODE_PATH = "/usr/local/bin/code";

// 実行ホスト（claude を実際に起動し /tmp に done-file/log・scaffold dir を持つ VM worker）か。
// claude-worker.ts が boot 時に process.env.SPM_EXEC_HOST="1" を設定する。
// Cloud Run orchestrator は設定しないため false。
// host-local 状態（claude の pid・done-file・scaffold dir）に依存する遷移は実行ホストのみで行う
// （#7: Cloud Run が VM 上の実行を自分の /tmp で誤判定し error 化するのを防ぐ）。
export function isExecHost(): boolean {
  return process.env.SPM_EXEC_HOST === "1";
}

// 承認・通知の宛先。creatorSlackId があれば本人 DM（threadTs なし）、
// なければ共有チャンネル＋プロジェクトスレッド。Slack 未設定なら null。
export interface SlackTarget {
  channel: string;
  threadTs?: string;
}

async function resolveSlackTarget(project: {
  slackThreadTs: string | null;
  creatorSlackId: string | null;
}): Promise<SlackTarget | null> {
  if (!slackConfigured()) return null;
  if (project.creatorSlackId) {
    const dm = await openDmChannel(project.creatorSlackId);
    if (dm) return { channel: dm };
    console.warn(
      `[TICK] DM open 失敗 → 共有チャンネルにフォールバック (creatorSlackId=${project.creatorSlackId})`,
    );
  }
  return {
    channel: approvalChannel(),
    threadTs: project.slackThreadTs ?? undefined,
  };
}

// SKIP_APPROVAL=true で承認をスキップ（開発・テスト用退避口）。
function skipApprovalEnabled(): boolean {
  return process.env.SKIP_APPROVAL === "true";
}

// SlackTarget 経由でメッセージ投稿（失敗は握りつぶす）。target が null なら何もしない。
async function notifySlack(target: SlackTarget | null, text: string): Promise<string> {
  if (!target) return "";
  return postSlackTo(target.channel, text, target.threadTs).catch(() => "");
}

const EXEC_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 時間
const MAX_LOG_CHARS = 30_000;

// advanceApproved が起動権を握るために execPid に立てるセンチネル値。
// 正常時は startClaudeCodeDetached が即座に返り、同一 tick 内で実 PID（executing）
// または error に確定するため execPid=-1 はサブ秒で消える。これが tick をまたいで
// 残っている＝spawn 途中でワーカーがクラッシュ/強制終了した取り残し（stale claim）。
const SPAWN_CLAIM_PID = -1;
// stale claim とみなすまでの猶予。正常な execPid=-1 はサブ秒なので 2 分あれば十分。
const SPAWN_CLAIM_STALE_MS = 2 * 60 * 1000;

// ネットワーク起因エラーの自動リトライ
const MAX_AUTO_RETRY = 3;
const NETWORK_ERROR_PATTERNS: RegExp[] = [
  /FailedToOpenSocket/i,
  /Unable to connect to API/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i,
  /socket hang up/i,
];
const CREDIT_ERROR_PATTERN = /Credit balance is too low/i;

// =============================================================================
// Slack 通知の共通フォーマット（改善4）
//   見出し: `Part{n}/{total} {動詞}: {タイトル}`
//   2 行目: リポジトリ: `repo`
// =============================================================================

interface PartNote {
  partNumber: number;
  total: number;
  title: string;
  repo: string;
}

// parallelWorkingDir の basename を取り出す。無ければ fallback（targetSystem 等）。
function repoBasename(
  workingDir: string | null | undefined,
  fallback?: string | null,
): string {
  const dir = (workingDir ?? "").replace(/[/\\]+$/, "");
  const base = dir.split(/[/\\]/).filter(Boolean).pop();
  return base || fallback || "";
}

// `Part1/5: タイトル` / `Part1/5 完了: タイトル`
function noteHead(note: PartNote, verb?: string): string {
  const base = verb ? `Part${note.partNumber}/${note.total} ${verb}` : `Part${note.partNumber}/${note.total}`;
  return note.title ? `${base}: ${note.title}` : base;
}

// `\nリポジトリ: \`repo\``（repo 不明なら空文字）
function repoLine(note: PartNote): string {
  return note.repo ? `\nリポジトリ: \`${note.repo}\`` : "";
}

// executionLog 末尾の非空行を抜粋（エラー原因表示用）
function errorExcerpt(log: string): string {
  if (!log) return "";
  const tail = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6)
    .join("\n");
  return tail.length > 500 ? tail.slice(-500) : tail;
}

export type TickAdvancedReason =
  | "approval_posted"
  | "approved"
  | "exec_started"
  | "completed"
  | "error"
  | "skipped"
  | "scaffolded";

export type TickResult =
  | { status: "busy" }
  | { status: "no_op"; reason: string }
  | { status: "done" }
  | { status: "advanced"; reason: TickAdvancedReason };

// =============================================================================
// 起動時復旧
// =============================================================================

// サーバー再起動時の復旧：
//   1) parallelRunId 全クリア（ロック解放）
//   2) executionStatus='executing' のパートを checkClaudeCode で判定し再分類
//        - success → completed（成果は残っている）
//        - running（プロセス生存）→ executing のまま継続監視
//        - failed/不明 → approvalState='approved' に戻し executionStatus='awaiting_approval'
//          execPid/execStartedAt/execDoneFile をクリア → 次 tick で再実行
//      ※「問答無用で error」は廃止。再実行可能にする
// execPid=SPAWN_CLAIM_PID(-1) のまま取り残された "stale spawn claim" を解放する。
// advanceApproved が起動権を握った直後にワーカーが死ぬと、executionStatus は
// 'awaiting_approval'（executing になる前）のまま execPid=-1 が残り、
// resolveAllReadyParts の approved 分類（execPid==null 必須）に二度と入れず spawn
// されない。さらに awaiting_approval 分類へ落ちて advanceAwaitingApproval により
// waiting へ巻き戻され、waiting⇄awaiting_approval を無限ループする。
//
// ここで execPid を null に戻すと、次 tick で approved 分類に復帰し再 spawn される。
// approvalState='approved' / executionStatus='awaiting_approval' は維持する。
//   staleMs=0  : 起動時復旧（残存 -1 は全て stale とみなす。並走 tick が無い前提）
//   staleMs>0  : 稼働中の定期スイープ（execStartedAt が staleMs より古い -1 のみ）
export async function recoverStaleSpawnClaims(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const reset = await prisma.document.updateMany({
    where: {
      type: "sprint_part",
      execPid: SPAWN_CLAIM_PID,
      OR: [{ execStartedAt: null }, { execStartedAt: { lt: cutoff } }],
    },
    data: { execPid: null, execStartedAt: null },
  });
  if (reset.count > 0) {
    console.log(
      `[TICK] ${reset.count} 件の stale spawn-claim (execPid=${SPAWN_CLAIM_PID}) を解放しました（再 spawn 対象に復帰）`,
    );
  }
  return reset.count;
}

export async function recoverFromCrash(): Promise<void> {
  const cleared = await prisma.project.updateMany({
    where: { parallelRunId: { not: null } },
    data: { parallelRunId: null },
  });
  if (cleared.count > 0) {
    console.log(`[TICK] ${cleared.count} 件の並列実行ロックを解放しました`);
  }

  // 以降は host-local（execPid/done-file）検査のため実行ホスト(VM)のみ実行する。
  // Cloud Run でこれを行うと VM 上の executing パートを自分の /tmp 視点で誤再分類する（#7）。
  // ロック解放（上記 parallelRunId クリア）は host 非依存なので Cloud Run でも実行済み。
  if (!isExecHost()) return;

  // 起動時：spawn 途中で取り残された execPid=-1 を全て解放（並走 tick は未起動）。
  await recoverStaleSpawnClaims(0);

  const executing = await prisma.document.findMany({
    where: {
      type: "sprint_part",
      executionStatus: "executing",
    },
    select: {
      id: true,
      partNumber: true,
      execPid: true,
      execDoneFile: true,
    },
  });

  let completedCount = 0;
  let retryCount = 0;
  let continueCount = 0;

  for (const p of executing) {
    if (!p.execDoneFile) {
      // execDoneFile が無い executing は完全に状態欠落。再実行へ。
      await prisma.document.update({
        where: { id: p.id },
        data: {
          executionStatus: "awaiting_approval",
          approvalState: "approved",
          execPid: null,
          execStartedAt: null,
          execDoneFile: null,
        },
      });
      retryCount++;
      continue;
    }

    const status = checkClaudeCode({
      pid: p.execPid,
      doneFile: p.execDoneFile,
    });

    if (status === "success") {
      const logTail = await readLogTailSafe(p.execDoneFile);
      await prisma.document.update({
        where: { id: p.id },
        data: {
          executionStatus: "completed",
          executedAt: new Date(),
          executionLog: logTail,
        },
      });
      completedCount++;
    } else if (status === "running") {
      // detached プロセスが生きている → そのまま継続監視
      continueCount++;
    } else {
      // failed: 再実行可能な状態（awaiting_approval + approved）に戻す
      await prisma.document.update({
        where: { id: p.id },
        data: {
          executionStatus: "awaiting_approval",
          approvalState: "approved",
          execPid: null,
          execStartedAt: null,
          execDoneFile: null,
        },
      });
      retryCount++;
    }
  }

  if (executing.length > 0) {
    console.log(
      `[TICK] executing ${executing.length} 件を判定: ` +
        `completed=${completedCount}, 継続=${continueCount}, 再実行=${retryCount}`,
    );
  }
}

async function readLogTailSafe(doneFile: string): Promise<string> {
  const logFile = doneFile.replace("/claude-done-", "/claude-log-");
  try {
    const content = await fsp.readFile(logFile, "utf-8");
    if (content.length > MAX_LOG_CHARS) return content.slice(-MAX_LOG_CHARS);
    return content;
  } catch {
    return "";
  }
}

export async function findRunnableProjects(): Promise<{ id: string }[]> {
  return prisma.project.findMany({
    // "scaffolding" も対象に含める（VM worker が拾って create-next-app を実行）。
    where: { parallelStatus: { in: ["running", "scaffolding"] }, parallelRunId: null },
    select: { id: true },
  });
}

// 新規プロジェクトの scaffold ステップ（VM worker 限定）。
// parallelStatus: "scaffolding" → (claim) "scaffolding_active" → "running" / "scaffold_error"
// claim は parallelStatus 遷移で行うため、running フェーズの parallelRunId とは干渉しない。
async function advanceScaffolding(
  project: { id: string; title: string; parallelWorkingDir: string | null },
  slack: SlackTarget | null,
): Promise<TickResult> {
  // Cloud Run（orchestrator / fireAndForgetTick / tick route）では scaffold しない。
  if (!isExecHost()) return { status: "no_op", reason: "exec_host_only" };

  const cwd = project.parallelWorkingDir;
  if (!cwd) {
    await prisma.project.updateMany({
      where: { id: project.id, parallelStatus: "scaffolding" },
      data: { parallelStatus: "scaffold_error" },
    });
    await notifySlack(slack, `❌ scaffold 不能: 作業ディレクトリ未設定（${project.title}）`);
    return { status: "no_op", reason: "scaffold_no_working_dir" };
  }

  // atomic claim: "scaffolding" → "scaffolding_active"（勝った tick だけが scaffold 実行）
  const claimed = await prisma.project.updateMany({
    where: { id: project.id, parallelStatus: "scaffolding" },
    data: { parallelStatus: "scaffolding_active" },
  });
  if (claimed.count === 0) return { status: "no_op", reason: "scaffold_claim_lost" };

  await notifySlack(slack, `🛠️ 新規プロジェクトを scaffold 中\n生成先: \`${cwd}\``);
  console.log(`[TICK] scaffold 開始 project=${project.id} cwd=${cwd}`);

  const result = await scaffoldNextApp(cwd, {
    onLog: (line) => process.stdout.write(`[scaffold ${project.id}] ${line}`),
  });

  if (!result.ok) {
    await prisma.project.updateMany({
      where: { id: project.id, parallelStatus: "scaffolding_active" },
      data: { parallelStatus: "scaffold_error" },
    });
    const reason = result.error
      ? `spawn error: ${result.error}`
      : `exit ${result.exitCode}`;
    await notifySlack(
      slack,
      `❌ *create-next-app 失敗*（${reason}）\n生成先: \`${cwd}\`\n` +
        "```\n" +
        (result.tail.slice(-1500) || "(出力なし)") +
        "\n```\n" +
        `リトライ: \`npm run retry-scaffold ${project.id}\``,
    );
    console.error(`[TICK] scaffold 失敗 project=${project.id} ${reason}`);
    return { status: "no_op", reason: "scaffold_failed" };
  }

  // scaffold 成功 → VS Code 起動は best-effort（ヘッドレス VM では code 不在で失敗しうる）。
  // spawn の ENOENT は非同期 'error' イベントで来るため、必ず listener を付けて握りつぶす。
  // （未処理だと worker プロセスがクラッシュし、scaffolding_active のまま取り残される）
  try {
    const codeProc = spawn(CODE_PATH, [cwd], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    codeProc.on("error", (err) => {
      console.warn(
        `[TICK] VS Code 起動失敗(best-effort, 無視) project=${project.id}: ${err instanceof Error ? err.message : err}`,
      );
    });
    codeProc.unref();
  } catch (e) {
    console.warn(
      `[TICK] VS Code 起動失敗(best-effort, 無視) project=${project.id}: ${e instanceof Error ? e.message : e}`,
    );
  }

  // "scaffolding_active" → "running"（実装フェーズへ）。parallelRunId は null のまま維持。
  await prisma.project.updateMany({
    where: { id: project.id, parallelStatus: "scaffolding_active" },
    data: { parallelStatus: "running", parallelRunId: null },
  });
  await notifySlack(slack, `✅ scaffold 完了 — 実装フェーズへ進みます\n生成先: \`${cwd}\``);
  console.log(`[TICK] scaffold 完了 project=${project.id} → running`);
  return { status: "advanced", reason: "scaffolded" };
}

// 非終端パート（waiting / awaiting_approval / executing）を持つのに
// Project.parallelStatus が 'running' 以外（'done' / null）になっている "取り残し" を
// 'running' に戻して再びワーカーの対象にする。
//
// 想定するケース：
//   - markProjectDone 後にユーザが手動で Document.executionStatus を waiting に戻した
//   - 運用中に DB を直接編集して状態を巻き戻した
//   - 何らかの理由で parallelStatus と Document 群の整合が崩れた
//
// archivedAt が立っている Project は対象外（ソフトデリートを尊重）。
// parallelDoneNotifiedAt は同時に null へ戻し、再完了時に再度通知できるようにする。
export async function resumeStuckProjects(): Promise<number> {
  const stuck = await prisma.document.findMany({
    where: {
      type: "sprint_part",
      executionStatus: { in: ["waiting", "awaiting_approval", "executing"] },
      project: {
        // scaffold フェーズ（"scaffolding"/"scaffolding_active"/"scaffold_error"）は
        // 巻き上げない。これらを "running" にすると create-next-app をスキップして
        // 存在しない dir で実装が走ってしまう（#5 の本丸）。
        parallelStatus: {
          notIn: ["running", "scaffolding", "scaffolding_active", "scaffold_error"],
        },
        archivedAt: null,
      },
    },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  console.log(`[TICK] resumeStuckProjects: stuck=${stuck.length}`);
  if (stuck.length === 0) return 0;
  const ids = Array.from(new Set(stuck.map((s) => s.projectId)));
  const updated = await prisma.project.updateMany({
    where: {
      id: { in: ids },
      // scaffold フェーズは巻き上げない（findMany 側で除外済みだが defense-in-depth）。
      parallelStatus: {
        notIn: ["running", "scaffolding", "scaffolding_active", "scaffold_error"],
      },
      archivedAt: null,
    },
    data: {
      parallelStatus: "running",
      parallelDoneNotifiedAt: null,
    },
  });
  if (updated.count > 0) {
    console.log(
      `[TICK] ${updated.count} 件の Project を running に復旧（非終端Document検出）`,
    );
  }
  return updated.count;
}

// =============================================================================
// ready 状態の全パートを決定
//
// 旧 acquireLock / releaseLock（Project.parallelRunId による tick 間ロック）は
// 撤廃した。排他制御は各 advance 関数の入口にある Document レベルの
// atomic claim（updateMany WHERE 現状態）が担う。これにより複数 tick が
// 同一プロジェクトに対し並走しても、各状態遷移は一度だけ実行される。
// =============================================================================

interface PartRow {
  id: string;
  partNumber: number;
  partTitle: string | null;
  content: string;
  executionStatus: string | null;
  approvalState: string | null;
  approvalPostedAt: Date | null;
  slackApprovalTs: string | null;
  notifiedStartAt: Date | null;
  notifiedDoneAt: Date | null;
  execPid: number | null;
  execStartedAt: Date | null;
  execDoneFile: string | null;
  dependsOn: unknown;
}

// tick 開始時点で「進められる」全パートを 4 種類に分類して返す。
// 分類は相互排他で、旧 resolveNextPart の優先順位と同一の述語を使う：
//   1) executing            : 実行中（完了検査対象）
//   2) approved             : approvalState='approved' かつ execPid 未設定（起動待ち）
//   3) awaitingApproval     : awaiting_approval かつ未承認（リアクション確認 or 再送）
//   4) waiting              : waiting かつ依存先が全て completed（承認リクエスト送信可能）
// approvalState='approved' に到達したパートは awaitingApproval から外す（approved へ）。
// execPid に claim 用センチネル(-1)が立つと approved 述語(execPid==null)からも外れ、
// 起動完了で executing に遷移するまでどの分類にも入らない（多重起動防止）。
export interface ReadyParts {
  waiting: PartRow[];
  awaitingApproval: PartRow[];
  approved: PartRow[];
  executing: PartRow[];
}

export async function resolveAllReadyParts(projectId: string): Promise<ReadyParts> {
  const parts = await prisma.document.findMany({
    where: { projectId, type: "sprint_part", partNumber: { not: null } },
    orderBy: { partNumber: "asc" },
    select: {
      id: true,
      partNumber: true,
      partTitle: true,
      content: true,
      executionStatus: true,
      approvalState: true,
      approvalPostedAt: true,
      slackApprovalTs: true,
      notifiedStartAt: true,
      notifiedDoneAt: true,
      execPid: true,
      execStartedAt: true,
      execDoneFile: true,
      dependsOn: true,
    },
  });

  const rows: PartRow[] = parts
    .filter((p) => p.partNumber != null)
    .map((p) => ({
      id: p.id,
      partNumber: p.partNumber as number,
      partTitle: p.partTitle,
      content: p.content,
      executionStatus: p.executionStatus,
      approvalState: p.approvalState,
      approvalPostedAt: p.approvalPostedAt,
      slackApprovalTs: p.slackApprovalTs,
      notifiedStartAt: p.notifiedStartAt,
      notifiedDoneAt: p.notifiedDoneAt,
      execPid: p.execPid,
      execStartedAt: p.execStartedAt,
      execDoneFile: p.execDoneFile,
      dependsOn: p.dependsOn,
    }));

  const completedNums = new Set(
    rows.filter((p) => p.executionStatus === "completed").map((p) => p.partNumber),
  );

  const result: ReadyParts = {
    waiting: [],
    awaitingApproval: [],
    approved: [],
    executing: [],
  };

  for (const p of rows) {
    if (p.executionStatus === "completed" || p.executionStatus === "skipped" || p.executionStatus === "error") {
      continue; // terminal
    }
    if (p.executionStatus === "executing") {
      result.executing.push(p);
      continue;
    }
    // spawn 起動権を握った直後のセンチネル。実 PID（executing）に確定するまで
    // どの分類にも入れない（approved を含む全 advance から除外）。tick をまたいで
    // 残った stale claim は recoverStaleSpawnClaims が execPid=null に戻して再 spawn
    // 対象へ復帰させる。ここで awaiting_approval/waiting 分類へ落とすと
    // advanceAwaitingApproval が waiting へ巻き戻し無限ループになるため、明示的に除外。
    if (p.execPid === SPAWN_CLAIM_PID) {
      continue;
    }
    if (p.approvalState === "approved" && p.execPid == null) {
      result.approved.push(p);
      continue;
    }
    if (p.executionStatus === "awaiting_approval") {
      result.awaitingApproval.push(p);
      continue;
    }
    if (p.executionStatus === "waiting") {
      const deps = Array.isArray(p.dependsOn) ? (p.dependsOn as number[]) : [];
      if (deps.every((d) => completedNums.has(d))) result.waiting.push(p);
    }
    // それ以外（依存未解決の waiting、claim 中の execPid=-1 等）は対象外
  }

  return result;
}

// =============================================================================
// 全完了判定
// =============================================================================

async function hasNonTerminal(projectId: string): Promise<boolean> {
  const remaining = await prisma.document.count({
    where: {
      projectId,
      type: "sprint_part",
      executionStatus: { in: ["waiting", "awaiting_approval", "executing"] },
    },
  });
  return remaining > 0;
}

async function markProjectDone(
  projectId: string,
  projectTitle: string,
  slack: SlackTarget | null,
): Promise<void> {
  // 🎉 完了通知の冪等化（複数 tick の並走で重複送信しないよう atomic claim）。
  // parallelDoneNotifiedAt IS NULL を満たす 1 tick だけが count=1 を得て通知する。
  const claimed = await prisma.project.updateMany({
    where: { id: projectId, parallelDoneNotifiedAt: null },
    data: { parallelDoneNotifiedAt: new Date() },
  });
  if (claimed.count > 0) {
    const errorCount = await prisma.document.count({
      where: { projectId, type: "sprint_part", executionStatus: "error" },
    });
    const msg =
      errorCount === 0
        ? `🎉 *【${projectTitle}】全パート完了*`
        : `⚠️ *【${projectTitle}】完了（${errorCount}件のエラーあり）*`;
    await notifySlack(slack, msg);
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { parallelStatus: "done" },
  });
  await prisma.session
    .updateMany({
      where: { projectId },
      data: { status: "completed" },
    })
    .catch(() => {});
}

// =============================================================================
// ステートマシン本体：1 tick = ready 全パートを並列に 1 ステップずつ進める
//
// 旧設計（1 tick で 1 パートだけ処理）から「依存解決済みの全 ready パートを
// Promise.all で同時に advance」へ拡張。同時実行上限なし。Project レベルの
// ロック（acquireLock）は撤廃し、各 advance 関数入口の Document atomic claim が
// 排他を担うため、複数 tick が並走しても各遷移は一度だけ起こる。
// =============================================================================

export async function processOneTick(
  projectId: string,
): Promise<TickResult> {
  try {
    return await processOneTickInner(projectId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : "";
    console.error(`[TICK] processOneTick(${projectId}) crashed: ${msg}\n${stack ?? ""}`);
    return { status: "no_op", reason: "exception" };
  }
}

async function processOneTickInner(
  projectId: string,
): Promise<TickResult> {
  const project = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        slackThreadTs: true,
        creatorSlackId: true,
        parallelStatus: true,
        parallelWorkingDir: true,
        targetSystem: true,
      },
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[TICK] findUnique(project=${projectId}) failed: ${msg}`);
      return null;
    });
  if (!project) return { status: "no_op", reason: "project_not_found" };

  // 承認・通知の宛先（creatorSlackId があれば本人 DM、なければ共有チャンネル＋スレッド）。
  const slack = await resolveSlackTarget(project);

  // 新規プロジェクトの scaffold ステップ（VM worker 限定）。
  // Cloud Run の fireAndForgetTick / tick route は isExecHost()=false で no_op になる。
  if (project.parallelStatus === "scaffolding") {
    return await advanceScaffolding(project, slack);
  }
  if (project.parallelStatus !== "running") {
    return { status: "no_op", reason: "not_running" };
  }

  const workingDir = project.parallelWorkingDir ?? process.cwd();

  // E) 非終端パートが 0 件 → done 化（markProjectDone が atomic claim で冪等化）
  if (!(await hasNonTerminal(projectId))) {
    await markProjectDone(projectId, project.title, slack);
    return { status: "done" };
  }

  const ready = await resolveAllReadyParts(projectId);
  const total = await prisma.document.count({
    where: { projectId, type: "sprint_part", partNumber: { not: null } },
  });
  const repo = repoBasename(project.parallelWorkingDir, project.targetSystem);

  console.log(
    `[TICK] project=${projectId} ready: waiting=${ready.waiting.length} awaitingApproval=${ready.awaitingApproval.length} approved=${ready.approved.length} executing=${ready.executing.length} total=${total}`,
  );

  // 通知フォーマット用コンテキスト（改善4）。状態遷移には影響しない読み取りのみ。
  const noteFor = (p: PartRow): PartNote => ({
    partNumber: p.partNumber,
    total,
    title: p.partTitle ?? "",
    repo,
  });

  // 各分類のパートをそれぞれの advance に投げる。advance 入口の atomic claim が
  // 重複処理を弾くため、ここでは ready 全件を無条件に並列起動してよい。
  type AdvanceJob = {
    partId: string;
    partNumber: number;
    phase: "executing" | "approved" | "awaitingApproval" | "waiting";
    // 観測用スナップショット（毎 tick ログに出す。遷移の診断を容易にする）
    executionStatus: string | null;
    approvalState: string | null;
    execPid: number | null;
    run: () => Promise<TickResult>;
  };
  const snapshot = (p: PartRow) => ({
    executionStatus: p.executionStatus,
    approvalState: p.approvalState,
    execPid: p.execPid,
  });
  const jobs: AdvanceJob[] = [
    // D) executing → checkClaudeCode で進捗確認
    ...ready.executing.map<AdvanceJob>((p) => ({
      partId: p.id,
      partNumber: p.partNumber,
      phase: "executing",
      ...snapshot(p),
      run: () => advanceExecuting(p, noteFor(p), slack),
    })),
    // C) approved & execPid 未設定 → Claude Code 起動
    ...ready.approved.map<AdvanceJob>((p) => ({
      partId: p.id,
      partNumber: p.partNumber,
      phase: "approved",
      ...snapshot(p),
      run: () => advanceApproved(p, noteFor(p), workingDir, slack),
    })),
    // B) awaiting_approval → リアクション確認
    ...ready.awaitingApproval.map<AdvanceJob>((p) => ({
      partId: p.id,
      partNumber: p.partNumber,
      phase: "awaitingApproval",
      ...snapshot(p),
      run: () => advanceAwaitingApproval(p, noteFor(p), slack),
    })),
    // A) waiting → 承認リクエスト送信
    ...ready.waiting.map<AdvanceJob>((p) => ({
      partId: p.id,
      partNumber: p.partNumber,
      phase: "waiting",
      ...snapshot(p),
      run: () => advanceWaiting(p, noteFor(p), slack),
    })),
  ];

  if (jobs.length === 0) return { status: "no_op", reason: "no_eligible_part" };

  // allSettled: 1 パートの advance が throw しても他パートの結果を握りつぶさない。
  // 各 advance は atomic claim で冪等なので、reject したパートは次 tick / 次ポーリングで
  // 安全に再試行される。Part ID と phase を入口・出口でログに出して、どの分類がどの
  // reason で止まっているかを観測可能にする（processed=0 の原因切り分け用）。
  const settled = await Promise.allSettled(
    jobs.map(async (j) => {
      console.log(
        `[TICK] part=${j.partId} partNum=${j.partNumber} phase=${j.phase} ` +
          `executionStatus=${j.executionStatus} approvalState=${j.approvalState} execPid=${j.execPid} starting`,
      );
      try {
        const r = await j.run();
        const tag =
          r.status === "advanced"
            ? `advanced(${r.reason})`
            : r.status === "no_op"
              ? `no_op(${r.reason})`
              : r.status;
        console.log(
          `[TICK] part=${j.partId} partNum=${j.partNumber} phase=${j.phase} -> ${tag}`,
        );
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[TICK] part=${j.partId} partNum=${j.partNumber} phase=${j.phase} threw: ${msg}`,
        );
        throw e;
      }
    }),
  );
  for (const r of settled) {
    if (r.status === "rejected") {
      console.error(`[TICK] advance rejected for ${projectId}:`, r.reason);
    }
  }
  const results = settled
    .filter((r): r is PromiseFulfilledResult<TickResult> => r.status === "fulfilled")
    .map((r) => r.value);

  // 1 件でも advanced があれば advanced を返す（fireAndForgetTick が即次 tick を駆動）。
  // 全件 no_op（claim 喪失・承認待ち等）なら no_op で停止 → 次ポーリングが拾う。
  const advanced = results.find((r) => r.status === "advanced");
  if (advanced) return advanced;
  return { status: "no_op", reason: "no_progress" };
}

// =============================================================================
// 各状態の遷移ヘルパー（すべて非ブロッキング）
// =============================================================================

// A) waiting → 承認リクエスト送信 → awaiting_approval
async function advanceWaiting(
  next: PartRow,
  note: PartNote,
  slack: SlackTarget | null,
): Promise<TickResult> {
  // atomic claim: approvalState を null/'none' → 'posting' に立てて、この承認送信を
  // 1 tick だけに限定する（executionStatus は 'waiting' のまま）。
  // 'posting' 中のパートは resolveAllReadyParts で waiting 分類のままだが、
  // 並走 tick の advanceWaiting も同じ claim で弾かれる（count=0 → no_op）。
  // executionStatus を 'awaiting_approval' に変えないので advanceAwaitingApproval の
  // 再送判定とも干渉しない。
  const claimed = await prisma.document.updateMany({
    where: {
      id: next.id,
      executionStatus: "waiting",
      OR: [{ approvalState: null }, { approvalState: "none" }],
    },
    data: { approvalState: "posting" },
  });
  if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };

  // SKIP_APPROVAL=true もしくは Slack 未設定（トークン無し）なら即 approved 直進。
  // ※「Slack に投稿できた＝approved」ではなく、ここは“承認を要求しない”明示ケースのみ。
  if (skipApprovalEnabled() || !slack) {
    await prisma.document.update({
      where: { id: next.id },
      data: {
        approvalState: "approved",
        approvalPostedAt: new Date(),
        executionStatus: "awaiting_approval",
      },
    });
    return { status: "advanced", reason: "approved" };
  }

  const approvalText =
    `🔧 *${noteHead(note)}*${repoLine(note)}\n\n` +
    `内容: ${next.content.slice(0, 200)}${next.content.length > 200 ? "..." : ""}\n\n` +
    `✅ または 👍 で承認 / ❌ でスキップ（リアクションが付くまで待機します）`;
  const approvalTs = await postSlackTo(slack.channel, approvalText, slack.threadTs);
  if (!approvalTs) {
    console.error(
      `[TICK] Part${next.partNumber} 承認メッセージ送信失敗。次tickで再試行`,
    );
    // claim を解除（'none' に戻す）して次 tick で再送可能にする。
    await prisma.document.update({
      where: { id: next.id },
      data: { approvalState: "none" },
    });
    return { status: "no_op", reason: "approval_post_failed" };
  }

  await prisma.document.update({
    where: { id: next.id },
    data: {
      executionStatus: "awaiting_approval",
      approvalState: "posted",
      approvalPostedAt: new Date(),
      slackApprovalTs: approvalTs,
    },
  });
  return { status: "advanced", reason: "approval_posted" };
}

// B) awaiting_approval → リアクションを 1 回だけ確認
async function advanceAwaitingApproval(
  next: PartRow,
  note: PartNote,
  slack: SlackTarget | null,
): Promise<TickResult> {
  // SKIP_APPROVAL=true もしくは Slack 未設定なら自動承認（リアクション待ちをしない）。
  // posted かどうかに関わらず awaiting_approval を approved にする。
  if (skipApprovalEnabled() || !slack) {
    const claimed = await prisma.document.updateMany({
      where: {
        id: next.id,
        executionStatus: "awaiting_approval",
        approvalState: { not: "approved" },
      },
      data: { approvalState: "approved" },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    return { status: "advanced", reason: "approved" };
  }

  // slackApprovalTs が無い（投稿に失敗したまま awaiting_approval になった等）なら
  // waiting に戻して次 tick で承認メッセージを再送する（atomic claim）。
  if (!next.slackApprovalTs) {
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "awaiting_approval" },
      data: {
        executionStatus: "waiting",
        approvalState: "none",
        approvalPostedAt: null,
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    return { status: "advanced", reason: "approval_posted" };
  }

  // リアクションを 1 回だけ確認。付くまでは pending=待機（自動承認しない）。
  const reaction = await checkReactionOnce(next.slackApprovalTs, slack.channel);

  if (reaction === "approved") {
    // approvalState='posted' → 'approved' を atomic claim（executionStatus は据置）。
    // 次 tick で approved 分類 → advanceApproved が起動する。
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, approvalState: "posted" },
      data: { approvalState: "approved" },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    return { status: "advanced", reason: "approved" };
  }

  if (reaction === "rejected") {
    // awaiting_approval → skipped を atomic claim。勝った tick だけがスキップ通知。
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "awaiting_approval" },
      data: {
        executionStatus: "skipped",
        approvalState: "rejected",
        executedAt: new Date(),
        notifiedDoneAt: new Date(),
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    await notifySlack(slack, `⏭️ *${noteHead(note, "スキップ")}*${repoLine(note)}`);
    return { status: "advanced", reason: "skipped" };
  }

  // pending: リアクション待ち（次ポーリングが拾う）。ここで承認扱いには絶対しない。
  return { status: "no_op", reason: "awaiting_reaction" };
}

// spawn 前に cwd の到達性を検証する。VM(Linux)では DB に macOS 由来の絶対パス
// （例: /root/spm-project-2）が残っており chdir で EACCES になるため、
//   1) 保存値が存在し R/W 可能ならそれを使う
//   2) 不可なら SPM_PROJECTS_ROOT/<basename> にフォールバック（無ければ mkdir -p）
//   3) いずれも不可なら明示メッセージで throw（呼び出し元の catch が executionLog に記録）
async function ensureAccessibleCwd(stored: string): Promise<string> {
  const tried: string[] = [];
  const cleaned = (stored ?? "").trim();
  const base = cleaned ? path.basename(cleaned.replace(/[/\\]+$/, "")) : "";
  const fallback = base ? path.join(projectsRoot(), base) : "";

  const candidates: string[] = [];
  if (cleaned) candidates.push(cleaned);
  if (fallback && fallback !== cleaned) candidates.push(fallback);

  for (const dir of candidates) {
    try {
      await fsp.access(dir, fsConstants.R_OK | fsConstants.W_OK);
      if (dir !== cleaned) {
        console.log(`[TICK] cwd フォールバック: ${cleaned || "(空)"} → ${dir}`);
      }
      return dir;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "ERR";
      tried.push(`${dir} (${code})`);
    }
  }

  // どれもアクセス不可 → フォールバック先を作成して再検証
  if (fallback) {
    try {
      await fsp.mkdir(fallback, { recursive: true });
      await fsp.access(fallback, fsConstants.R_OK | fsConstants.W_OK);
      console.log(`[TICK] cwd 作成: ${fallback}`);
      return fallback;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "ERR";
      tried.push(`mkdir ${fallback} (${code})`);
    }
  }

  throw new Error(`cwdアクセス不可: ${tried.join(", ") || "(候補なし)"}`);
}

// C) approvalState='approved' & execPid未設定 → Claude Code 起動だけして即返す
async function advanceApproved(
  next: PartRow,
  note: PartNote,
  workingDir: string,
  slack: SlackTarget | null,
): Promise<TickResult> {
  // claude 起動は host-local（生成物・pid が VM に属する）。実行ホスト以外では起動しない（#7）。
  if (!isExecHost()) return { status: "no_op", reason: "exec_host_only" };
  // atomic claim: execPid を null → -1（センチネル）に立てて起動権を 1 tick に限定する。
  // execPid=-1 のパートは resolveAllReadyParts で approved 分類(execPid==null)から外れ、
  // executionStatus は据置（awaiting_approval だが approvalState='approved' なので
  // awaitingApproval 分類からも外れる）→ 起動完了で executing になるまで二重起動されない。
  const claimed = await prisma.document.updateMany({
    where: {
      id: next.id,
      execPid: null,
      approvalState: "approved",
      executionStatus: { notIn: ["completed", "skipped", "error", "executing"] },
    },
    data: { execPid: -1, execStartedAt: new Date() },
  });
  if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };

  // 開始通知（冪等）。Slack 設定なし or 送信成功時のみ notifiedStartAt を set。
  // 送信失敗時は set せず（次に approved 状態へ戻った際に再送される）。実行自体は止めない。
  if (!next.notifiedStartAt) {
    let notified = true;
    if (slack) {
      const ts = await notifySlack(slack, `✅ *${noteHead(note, "実行開始")}*${repoLine(note)}`);
      notified = Boolean(ts);
    }
    if (notified) {
      await prisma.document.update({
        where: { id: next.id },
        data: { notifiedStartAt: new Date() },
      });
    }
  }

  try {
    // spawn 前に cwd の存在・権限を検証し、不可なら SPM_PROJECTS_ROOT 配下へフォールバック。
    // 解決不能なら throw → 下の catch が executionStatus='error' と executionLog に記録する。
    const cwd = await ensureAccessibleCwd(workingDir);
    const spawned = await startClaudeCodeDetached(
      next.content,
      cwd,
      noteHead(note),
    );
    await prisma.document.update({
      where: { id: next.id },
      data: {
        executionStatus: "executing",
        execPid: spawned.pid,
        execStartedAt: new Date(),
        execDoneFile: spawned.doneFile,
        executionLog: `[起動] PID=${spawned.pid} doneFile=${spawned.doneFile} logFile=${spawned.logFile}\n`,
      },
    });
    return { status: "advanced", reason: "exec_started" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? (e.stack ?? "") : "";
    console.error(`[TICK] Part${next.partNumber} 起動失敗: ${msg}\n${stack}`);
    await notifySlack(
      slack,
      `❌ *${noteHead(note, "起動失敗")}*${repoLine(note)}\n原因: ${msg.slice(0, 200)}`,
    );
    await prisma.document.update({
      where: { id: next.id },
      data: {
        executionStatus: "error",
        execPid: null,
        execStartedAt: null,
        executedAt: new Date(),
        notifiedDoneAt: new Date(),
        executionLog: `[spawn失敗] ${msg}\n${stack}`.slice(0, MAX_LOG_CHARS),
      },
    });
    return { status: "advanced", reason: "error" };
  }
}

// D) executing → checkClaudeCode で結果のみ判定
async function advanceExecuting(
  next: PartRow,
  note: PartNote,
  slack: SlackTarget | null,
): Promise<TickResult> {
  // pid/done-file の検査は host-local。実行ホスト以外では判定しない（#7: 誤 error 化防止）。
  if (!isExecHost()) return { status: "no_op", reason: "exec_host_only" };
  if (!next.execDoneFile) {
    // execDoneFile 不在＝起動時の状態欠落。再実行可能状態に戻す（atomic claim）。
    // 通常フローでは spawn が executionStatus='executing' と execDoneFile を同時に
    // set するため到達しない。recovery 等の状態欠落に対する保険。
    console.warn(
      `[TICK] Part${next.partNumber} execDoneFile 不在のため再実行対象に戻します`,
    );
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "executing" },
      data: {
        executionStatus: "awaiting_approval",
        execPid: null,
        execStartedAt: null,
        execDoneFile: null,
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    return { status: "advanced", reason: "approved" };
  }

  // done/log を一度に読み取り exitCode とログを取得（[RUNNER] ログを必ず出力）。
  const inspect = await inspectExec(next.execDoneFile, next.execPid);
  const status = inspect.status;

  if (status === "running") {
    // タイムアウト判定
    const startedAt = next.execStartedAt?.getTime() ?? Date.now();
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      // executing → error を atomic claim。勝った tick だけが kill / 通知する。
      const claimed = await prisma.document.updateMany({
        where: { id: next.id, executionStatus: "executing" },
        data: {
          executionStatus: "error",
          executedAt: new Date(),
          notifiedDoneAt: new Date(),
        },
      });
      if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
      console.error(
        `[TICK] Part${next.partNumber} タイムアウト（3時間超）。プロセスを kill します`,
      );
      if (next.execPid != null && next.execPid > 0) {
        try {
          process.kill(next.execPid, "SIGTERM");
        } catch {
          // already dead
        }
      }
      await notifySlack(
        slack,
        `❌ *${noteHead(note, "タイムアウト")}*${repoLine(note)}\n（3時間超のため強制終了）`,
      );
      return { status: "advanced", reason: "error" };
    }
    return { status: "no_op", reason: "still_running" };
  }

  // success / failed — ログは inspectExec で読み込み済み。
  const logTail = inspect.log;

  if (status === "success") {
    // exitCode=0 は必ず completed にする（ログ有無に関わらず）。
    // 完了通知の送信権を notifiedDoneAt の atomic claim で 1 tick に限定する。
    // 送信失敗時は notifiedDoneAt を null に戻し executing のまま no_op を返す
    // （doneFile が success を保持するため次 tick で再送・冪等）。
    if (slack) {
      const notifyClaim = await prisma.document.updateMany({
        where: { id: next.id, executionStatus: "executing", notifiedDoneAt: null },
        data: { notifiedDoneAt: new Date() },
      });
      if (notifyClaim.count > 0) {
        const ts = await notifySlack(slack, `✅ *${noteHead(note, "完了")}*${repoLine(note)}`);
        if (!ts) {
          await prisma.document.update({
            where: { id: next.id },
            data: { notifiedDoneAt: null },
          });
          return { status: "no_op", reason: "done_notify_failed" };
        }
      }
    }
    // executing → completed を atomic claim（通知済み・未通知いずれでも冪等に確定）。
    // ログが非空なら必ず executionLog に保存する。
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "executing" },
      data: {
        executionStatus: "completed",
        executedAt: new Date(),
        notifiedDoneAt: new Date(),
        executionLog: logTail,
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    console.log(
      `[TICK] part=${next.id} partNum=${next.partNumber} phase=executing log persisted (${inspect.logSize} bytes)`,
    );
    return { status: "advanced", reason: "completed" };
  }

  // ---- failed ----
  // PartRow には手を入れず、ここで必要なメタだけ取得する
  const meta = await prisma.document.findUnique({
    where: { id: next.id },
    select: { retryCount: true },
  });
  const retryCount = meta?.retryCount ?? 0;

  // クレジット残高不足は自動リトライ対象外 → 即 error 確定
  if (CREDIT_ERROR_PATTERN.test(logTail)) {
    return await finalizeExecError(
      next.id,
      logTail,
      slack,
      `💳 *${noteHead(note, "クレジット残高不足")}*${repoLine(note)}\nhttps://console.anthropic.com/settings/billing で補充してください`,
    );
  }

  // ネットワーク起因エラー かつ リトライ上限未満 → 自動で再実行可能化
  if (
    NETWORK_ERROR_PATTERNS.some((re) => re.test(logTail)) &&
    retryCount < MAX_AUTO_RETRY
  ) {
    const nextRetry = retryCount + 1;
    // executing → awaiting_approval(+approved) を atomic claim。勝った tick だけが通知。
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "executing" },
      data: {
        executionStatus: "awaiting_approval",
        approvalState: "approved",
        retryCount: nextRetry,
        execPid: null,
        execStartedAt: null,
        execDoneFile: null,
        executionLog: logTail,
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    await notifySlack(
      slack,
      `🔄 *${noteHead(note, `自動リトライ (${nextRetry}/${MAX_AUTO_RETRY})`)}*${repoLine(note)}`,
    );
    return { status: "advanced", reason: "approved" };
  }

  // それ以外（非ネットワーク or リトライ上限到達）→ error 確定
  const cause = errorExcerpt(logTail);
  return await finalizeExecError(
    next.id,
    logTail,
    slack,
    `❌ *${noteHead(note, "エラー")}*${repoLine(note)}${cause ? `\n原因: ${cause}` : ""}`,
  );
}

// failed パートを error 確定させる。エラー通知の送信権を notifiedErrorAt の
// atomic claim で 1 tick に限定する。送信失敗時は notifiedErrorAt を null に戻し
// executing のまま no_op を返す（doneFile が failed を保持するため次 tick で再送・冪等）。
async function finalizeExecError(
  docId: string,
  logTail: string,
  slack: SlackTarget | null,
  message: string,
): Promise<TickResult> {
  if (slack) {
    const notifyClaim = await prisma.document.updateMany({
      where: { id: docId, executionStatus: "executing", notifiedErrorAt: null },
      data: { notifiedErrorAt: new Date() },
    });
    if (notifyClaim.count > 0) {
      const ts = await notifySlack(slack, message);
      if (!ts) {
        await prisma.document.update({
          where: { id: docId },
          data: { notifiedErrorAt: null },
        });
        return { status: "no_op", reason: "error_notify_failed" };
      }
    }
  }
  // executing → error を atomic claim（通知済み・未通知いずれでも冪等に確定）。
  const claimed = await prisma.document.updateMany({
    where: { id: docId, executionStatus: "executing" },
    data: {
      executionStatus: "error",
      executedAt: new Date(),
      notifiedErrorAt: new Date(),
      executionLog: logTail,
    },
  });
  if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
  return { status: "advanced", reason: "error" };
}

interface ExecInspect {
  status: "running" | "success" | "failed";
  exitCode: number | null;
  logFile: string;
  log: string;
  logSize: number;
}

// doneFile / logFile を一度に読み取り、exitCode とログ本文を返す。
// logFile は doneFile と同じ uuid を持つ命名規則：
//   doneFile = /tmp/claude-done-<uuid> → logFile = /tmp/claude-log-<uuid>
// 判定規則（黙って error にしない・読み取り例外もログする）：
//   - doneFile あり: exitCode=0 → success / それ以外 → failed
//   - doneFile なし & pid 生存 → running / pid 死亡 → failed
// 必ず [RUNNER] ログ（runId/doneFile/logFile/exitCode/logSize）を出力する。
async function inspectExec(doneFile: string, pid: number | null): Promise<ExecInspect> {
  const runId = doneFile.split("claude-done-")[1] ?? doneFile;
  const logFile = doneFile.replace("/claude-done-", "/claude-log-");

  let log = "";
  try {
    const content = await fsp.readFile(logFile, "utf-8");
    log = content.length > MAX_LOG_CHARS ? content.slice(-MAX_LOG_CHARS) : content;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`[RUNNER] logFile 読み取り失敗 ${logFile}: ${code}`);
    }
  }
  const logSize = Buffer.byteLength(log, "utf-8");

  let exitCode: number | null = null;
  let doneExists = false;
  try {
    const raw = (await fsp.readFile(doneFile, "utf-8")).trim();
    doneExists = true;
    const n = Number.parseInt(raw, 10);
    exitCode = Number.isNaN(n) ? null : n;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") {
      console.warn(`[RUNNER] doneFile 読み取り失敗 ${doneFile}: ${code}`);
    }
  }

  let status: ExecInspect["status"];
  if (doneExists) {
    status = exitCode === 0 ? "success" : "failed";
  } else if (pid != null) {
    try {
      process.kill(pid, 0);
      status = "running";
    } catch {
      status = "failed";
    }
  } else {
    status = "failed";
  }

  console.log(
    `[RUNNER] checkClaudeCode runId=${runId} doneFile=${doneFile} logFile=${logFile} exitCode=${exitCode} logSize=${logSize}`,
  );
  return { status, exitCode, logFile, log, logSize };
}

// =============================================================================
// fire-and-forget 駆動
// =============================================================================

// advanced で 1 ステップ進んだら即座に次 tick を再帰呼び出し。
// no_op / busy / done で停止し、次のポーリング（5秒）が拾う。
export function fireAndForgetTick(projectId: string): void {
  void processOneTick(projectId)
    .then((res) => {
      if (res.status === "advanced") {
        fireAndForgetTick(projectId);
      }
    })
    .catch((e) => {
      console.error(`[TICK] processOneTick error for ${projectId}:`, e);
    });
}
