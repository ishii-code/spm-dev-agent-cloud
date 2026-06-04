import { promises as fsp, constants as fsConstants } from "fs";
import path from "path";
import { prisma } from "./prisma";
import { projectsRoot } from "./repos";
import { parseAskHuman } from "./ask-human";
import { pickMentionId, pickHitlAnswer } from "./slack-mention";
import {
  detectChanges,
  detectBoilerplate,
  runBuildCheck,
  buildCriticPrompt,
  parseVerifyVerdict,
} from "./verify";
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
  readUserReplies,
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
  // メンション対象 ID（owner.slackId → creatorSlackId → 固定）。undefined なら withMention が固定にフォールバック。
  mentionId?: string;
}

// owner(User) の slackId を引く。ownerId 未設定/未登録は null。
async function ownerSlackId(ownerId: number | null | undefined): Promise<string | null> {
  if (ownerId == null) return null;
  const u = await prisma.user
    .findUnique({ where: { id: ownerId }, select: { slackId: true } })
    .catch(() => null);
  return u?.slackId ?? null;
}

// メンション対象 ID をチェーン解決：owner.slackId → creatorSlackId → undefined（固定へフォールバック）。
export async function mentionFor(project: {
  ownerId: number | null;
  creatorSlackId: string | null;
}): Promise<string | undefined> {
  return pickMentionId(await ownerSlackId(project.ownerId), project.creatorSlackId);
}

async function resolveSlackTarget(project: {
  slackThreadTs: string | null;
  creatorSlackId: string | null;
  ownerId: number | null;
}): Promise<SlackTarget | null> {
  if (!slackConfigured()) return null;
  const oid = await ownerSlackId(project.ownerId);
  const mentionId = pickMentionId(oid, project.creatorSlackId);
  // DM 宛先も owner.slackId を優先（無ければ creatorSlackId）。現 creatorSlackId 動作は保持。
  const dmId = oid ?? project.creatorSlackId;
  if (dmId) {
    const dm = await openDmChannel(dmId);
    if (dm) return { channel: dm, mentionId };
    console.warn(`[TICK] DM open 失敗 → 共有チャンネルにフォールバック (dmId=${dmId})`);
  }
  return {
    channel: approvalChannel(),
    threadTs: project.slackThreadTs ?? undefined,
    mentionId,
  };
}

// SKIP_APPROVAL=true で承認をスキップ（開発・テスト用退避口）。
function skipApprovalEnabled(): boolean {
  return process.env.SKIP_APPROVAL === "true";
}

// 検証ゲート（Phase D）。OFF（既定）＝従来どおり markProjectDone を即実行＝挙動完全不変。
// "1" / "true" で ON（VM のみ。Cloud Run は isExecHost()=false で verifying に入らない）。
function verifyBeforeDoneEnabled(): boolean {
  return process.env.VERIFY_BEFORE_DONE === "1" || process.env.VERIFY_BEFORE_DONE === "true";
}

// SlackTarget 経由でメッセージ投稿（失敗は握りつぶす）。target が null なら何もしない。
async function notifySlack(target: SlackTarget | null, text: string): Promise<string> {
  if (!target) return "";
  return postSlackTo(target.channel, text, target.threadTs, target.mentionId).catch(() => "");
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

// HITL（実行中の人間判断）誘導プロンプト。並列パスの spawn でのみ前置する
// （非並列パスは [[ASK_HUMAN]] を解釈しないため永久待ちになる。グローバル注入は禁止）。
// マーカー構文は parseAskHuman() の正規表現と厳密に一致させること。
const HITL_INSTRUCTION = `# 人間への確認（HITL）— 重要
あなたは無人で並列実行されています。実装の「土台」に関わる判断で、推測するとあとで手戻り・本番事故・コンプライアンス違反になりうる場合は、ファイルを書く前に必ず人間へ確認してください。

## 確認すべき「土台」判断（例）
- データ仕様・スキーマ（保存する項目／型／必須・任意）
- 個人情報・要配慮個人情報（病歴・診療・遺伝情報）のマスキング／匿名化方針
- AI 学習データとしての利用可否・制約
- 技術スタック／ライブラリの選定（一度決めると剥がしにくいもの）
- 本番環境・既存データに影響する操作

## 確認の出し方（厳守）
確認が必要になったら、出力の中で **次の1行だけ** を独立した行として出力し、**それ以上ファイルを書かずに終了** してください：
[[ASK_HUMAN]] {"q":"<具体的で1文の質問>","choices":["<選択肢1>","<選択肢2>"]}
- q は必須・具体的・1文。「どうしますか？」のような曖昧な質問は禁止。
- 選択肢が有限なら choices に列挙（人間は番号で回答できる）。自由記述で良ければ choices は省略可。
- JSON は1行・ダブルクオート・改行なし。複数行や説明文を同じ行に混ぜない。
- 人間の回答は次回起動時に「[人間の回答]」として渡されます。それを前提に実装を再開してください。

## 出しすぎない
すでに明確に決まっている事・些末な実装詳細では確認を出さないこと。確認は本当に土台を左右する分岐のみに限る。
`;

// 並列パートのプロンプトに HITL 誘導を前置する。
function withHitlPreamble(content: string): string {
  return `${HITL_INSTRUCTION}\n---\n# タスク\n${content}`;
}

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
  | "scaffolded"
  | "needs_human"
  | "human_answered"
  | "blocked"
  | "verifying"
  | "verify_progress"
  | "needs_review"
  | "verified_done";

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
  humanQuestion: string | null;
  humanChoices: unknown;
  humanQuestionTs: string | null;
  humanAnswer: string | null;
  humanAskedAt: Date | null;
  humanRenotifiedAt: Date | null;
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
  needsHuman: PartRow[];
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
      humanQuestion: true,
      humanChoices: true,
      humanQuestionTs: true,
      humanAnswer: true,
      humanAskedAt: true,
      humanRenotifiedAt: true,
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
      humanQuestion: p.humanQuestion,
      humanChoices: p.humanChoices,
      humanQuestionTs: p.humanQuestionTs,
      humanAnswer: p.humanAnswer,
      humanAskedAt: p.humanAskedAt,
      humanRenotifiedAt: p.humanRenotifiedAt,
    }));

  const completedNums = new Set(
    rows.filter((p) => p.executionStatus === "completed").map((p) => p.partNumber),
  );

  const result: ReadyParts = {
    waiting: [],
    awaitingApproval: [],
    approved: [],
    executing: [],
    needsHuman: [],
  };

  for (const p of rows) {
    if (p.executionStatus === "completed" || p.executionStatus === "skipped" || p.executionStatus === "error") {
      continue; // terminal
    }
    // HITL: needs_human / blocked は専用 advance（completed にしない・依存は進めない）。
    // blocked も late reply 復帰のため needsHuman に入れる（advanceWaitingForHuman 内で区別）。
    if (p.executionStatus === "needs_human" || p.executionStatus === "blocked") {
      result.needsHuman.push(p);
      continue;
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
      executionStatus: {
        in: ["waiting", "awaiting_approval", "executing", "needs_human", "blocked"],
      },
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
        ownerId: true,
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
  // 検証ゲート（Phase D）：verifying（3層検証）/ needs_review（人間レビュー待ち）は専用 advance。VM 限定。
  if (project.parallelStatus === "verifying" || project.parallelStatus === "needs_review") {
    return await advanceVerification(project, slack);
  }
  if (project.parallelStatus !== "running") {
    return { status: "no_op", reason: "not_running" };
  }

  const workingDir = project.parallelWorkingDir ?? process.cwd();

  // E) 非終端パートが 0 件 → 完了処理。
  if (!(await hasNonTerminal(projectId))) {
    // VERIFY_BEFORE_DONE=ON かつ VM(isExecHost) のときだけ verifying を挟む。
    // OFF（既定）/Cloud Run は従来どおり markProjectDone を即実行＝挙動不変。
    if (verifyBeforeDoneEnabled() && isExecHost()) {
      const claimed = await prisma.project.updateMany({
        where: { id: projectId, parallelStatus: "running" },
        data: { parallelStatus: "verifying" },
      });
      if (claimed.count === 0) return { status: "no_op", reason: "verify_claim_lost" };
      console.log(`[TICK] project=${projectId} → verifying（検証ゲート）`);
      return { status: "advanced", reason: "verifying" };
    }
    await markProjectDone(projectId, project.title, slack);
    return { status: "done" };
  }

  const ready = await resolveAllReadyParts(projectId);
  const total = await prisma.document.count({
    where: { projectId, type: "sprint_part", partNumber: { not: null } },
  });
  const repo = repoBasename(project.parallelWorkingDir, project.targetSystem);

  console.log(
    `[TICK] project=${projectId} ready: waiting=${ready.waiting.length} awaitingApproval=${ready.awaitingApproval.length} approved=${ready.approved.length} executing=${ready.executing.length} needsHuman=${ready.needsHuman.length} total=${total}`,
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
    phase: "executing" | "approved" | "awaitingApproval" | "waiting" | "needsHuman";
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
    // E) needs_human / blocked → HITL（質問投稿・回答待ち・回答で再 spawn）
    ...ready.needsHuman.map<AdvanceJob>((p) => ({
      partId: p.id,
      partNumber: p.partNumber,
      phase: "needsHuman",
      ...snapshot(p),
      run: () => advanceWaitingForHuman(p, noteFor(p), workingDir, slack),
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
  // 承認依頼も新規ルートメッセージで投稿（reactions は threading 非依存だが、両方を root に統一）。
  const approvalTs = await postSlackTo(slack.channel, approvalText, undefined, slack.mentionId);
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

// E) needs_human / blocked → HITL（実行中の人間判断）。post/poll/resume はすべて VM 限定。
//   needs_human + ts無 → Slack 質問投稿（mention は withMention で自動）
//   needs_human/blocked + ts有 → 回答確認（番号→choice / テキスト / ✅❌）→ 回答で原prompt＋回答を
//     注入して claude 再 spawn（executing 復帰・多段のため human* リセット）
//   needs_human 30分無回答 → blocked（auto-proceed しない）。blocked は late reply で復帰・再通知はスロットル。
async function advanceWaitingForHuman(
  next: PartRow,
  note: PartNote,
  workingDir: string,
  slack: SlackTarget | null,
): Promise<TickResult> {
  if (!isExecHost()) return { status: "no_op", reason: "exec_host_only" };
  const HUMAN_TIMEOUT_MS = Number(process.env.HITL_TIMEOUT_MS ?? 30 * 60 * 1000);
  const HITL_RENOTIFY_MS = Number(process.env.HITL_RENOTIFY_MS ?? 30 * 60 * 1000);
  const channel = slack?.channel;

  // 1) 未投稿（needs_human かつ ts無）→ Slack 質問投稿
  if (next.executionStatus === "needs_human" && !next.humanQuestionTs) {
    const claim = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "needs_human", humanAskedAt: null },
      data: { humanAskedAt: new Date() }, // post-once claim 兼 timeout 起点
    });
    if (claim.count === 0) return { status: "no_op", reason: "claim_lost" };
    if (!slack || !channel) {
      await prisma.document.updateMany({
        where: { id: next.id, executionStatus: "needs_human" },
        data: { executionStatus: "blocked" },
      });
      console.warn(`[TICK] Part${next.partNumber} HITL: Slack 未設定→blocked`);
      return { status: "advanced", reason: "blocked" };
    }
    const choices = Array.isArray(next.humanChoices) ? (next.humanChoices as string[]) : [];
    const choiceLines = choices.length
      ? "\n" + choices.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n（番号 or テキストでスレッド返信）"
      : "\n（このスレッドに回答を返信してください）";
    const text =
      `🤔 *${noteHead(note, "確認(HITL)")}*${repoLine(note)}\n` +
      `${next.humanQuestion ?? "(質問本文なし)"}${choiceLines}\n` +
      `はい/いいえは ✅ / ❌ リアクションでも可`;
    // 質問は「新規ルートメッセージ」で投稿（threadTs を渡さない）。これにより質問 ts が真の
    // スレッド親になり、回答(返信)を conversations.replies(質問ts) で確実に拾える。
    // プロジェクトスレッドにぶら下げると返信がルートに付き、並列 HITL で質問別に判別できない。
    const ts = await postSlackTo(channel, text, undefined, slack.mentionId);
    if (!ts) {
      await prisma.document.update({ where: { id: next.id }, data: { humanAskedAt: null } });
      return { status: "no_op", reason: "hitl_post_failed" };
    }
    await prisma.document.update({ where: { id: next.id }, data: { humanQuestionTs: ts } });
    console.log(`[TICK] Part${next.partNumber} HITL 質問投稿 ts=${ts}`);
    return { status: "advanced", reason: "needs_human" };
  }

  // 2) 投稿済み → 回答確認（本人のスレッド最新返信を優先、無ければ ✅/❌ リアクション）
  const ts = next.humanQuestionTs;
  if (!ts) return { status: "no_op", reason: "hitl_no_ts" };
  const ch = channel ?? approvalChannel();
  // 受理対象＝owner.slackId(=slack.mentionId で解決済) ∪ 固定 ID。owner 未設定なら固定のみ（後方互換・anti-spoof）。
  const FIXED_ID = process.env.SLACK_MENTION_USER_ID ?? process.env.ASK_USER_ID ?? "U0AMRAQDW65";
  const acceptIds = Array.from(new Set([slack?.mentionId, FIXED_ID].filter(Boolean) as string[]));
  const choices = Array.isArray(next.humanChoices) ? (next.humanChoices as string[]) : [];
  let answer: string | null = null;
  const replies = await readUserReplies(ts, ch, acceptIds);
  // 番号選択式は有効番号を優先（meta テキストは回答にしない）、自由記述は最新返信。
  answer = pickHitlAnswer(replies, choices);
  if (!answer) {
    const r = await checkReactionOnce(ts, ch);
    if (r === "approved") answer = "はい";
    else if (r === "rejected") answer = "いいえ";
  }

  // 3) 回答あり → 原prompt＋回答を注入して再 spawn（executing 復帰・human* リセット）
  if (answer) {
    const cwd = await ensureAccessibleCwd(workingDir).catch(() => null);
    if (!cwd) return { status: "no_op", reason: "cwd_unavailable" };
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: { in: ["needs_human", "blocked"] }, execPid: null },
      data: { execPid: SPAWN_CLAIM_PID, execStartedAt: new Date() },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    const resumePrompt =
      `${withHitlPreamble(next.content)}\n\n[人間の回答] Q: ${next.humanQuestion ?? ""}\nA: ${answer}\n` +
      `この回答を前提に改めて実装を完了してください（再度判断が必要なら [[ASK_HUMAN]] を1行で出して停止）。`;
    let spawned;
    try {
      spawned = await startClaudeCodeDetached(resumePrompt, cwd, noteHead(note));
    } catch (e) {
      await prisma.document.update({
        where: { id: next.id },
        data: { execPid: null, execStartedAt: null },
      });
      console.error(`[TICK] Part${next.partNumber} HITL 再spawn失敗: ${e instanceof Error ? e.message : e}`);
      return { status: "no_op", reason: "respawn_failed" };
    }
    await prisma.document.update({
      where: { id: next.id },
      data: {
        executionStatus: "executing",
        execPid: spawned.pid,
        execStartedAt: new Date(),
        execDoneFile: spawned.doneFile,
        executionLog: `[HITL再開] PID=${spawned.pid} 回答=${answer.slice(0, 60)}\n`,
        humanAnswer: answer,
        // 多段：次の [[ASK_HUMAN]] を新規投稿できるようリセット
        humanQuestionTs: null,
        humanAskedAt: null,
        humanRenotifiedAt: null,
      },
    });
    await notifySlack(slack, `▶️ *${noteHead(note, "回答受領・再開")}*${repoLine(note)}\n回答: ${answer.slice(0, 80)}`).catch(() => {});
    console.log(`[TICK] Part${next.partNumber} HITL 回答受領→再spawn pid=${spawned.pid}`);
    return { status: "advanced", reason: "human_answered" };
  }

  // 4) 回答なし → needs_human の 30分タイムアウトで blocked（auto-proceed しない）
  const askedAt = next.humanAskedAt?.getTime() ?? Date.now();
  if (next.executionStatus === "needs_human" && Date.now() - askedAt > HUMAN_TIMEOUT_MS) {
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "needs_human" },
      data: { executionStatus: "blocked", humanRenotifiedAt: new Date() },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    await notifySlack(slack, `⏸️ *${noteHead(note, "保留(blocked)")}*${repoLine(note)}\n30分回答なし。後でスレッド返信すれば再開します（自動では進めません）。`).catch(() => {});
    console.log(`[TICK] Part${next.partNumber} HITL → blocked(timeout)`);
    return { status: "advanced", reason: "blocked" };
  }

  // 5) blocked かつ回答なし → 再通知スロットル（鳴らし続けない）
  if (next.executionStatus === "blocked") {
    const lastNotif = next.humanRenotifiedAt?.getTime() ?? 0;
    if (Date.now() - lastNotif > HITL_RENOTIFY_MS) {
      const c = await prisma.document.updateMany({
        where: { id: next.id, executionStatus: "blocked" },
        data: { humanRenotifiedAt: new Date() },
      });
      if (c.count > 0) {
        await postSlackTo(ch, `🔔 未回答の確認があります（${noteHead(note)}）。スレッド返信で再開します。`, ts, slack?.mentionId).catch(() => {});
      }
    }
    return { status: "no_op", reason: "hitl_blocked_waiting" };
  }

  return { status: "no_op", reason: "awaiting_human" };
}

// ===========================================================================
// 検証ゲート（Phase D）：verifying（4層検証）/ needs_review（人間レビュー）。VM 限定。
// 検証メタは sentinel Document(type:"verification") に保持（HITL 列を流用）：
//   executionStatus: pending→build_running→critic_running→passed / needs_review / overridden
//   execPid/execDoneFile: build/critic の detached 実行（inspectExec で判定）
//   humanQuestion: needs_review の理由（reasons）/ humanQuestionTs: 🔎 投稿 ts（override poll 用）
// 層：① 変更検知 → ①.5 ボイラープレート検知（決定論） → ② build → ③ critic（仕様充足）
// ===========================================================================
type VerifyProject = {
  id: string;
  title: string;
  parallelWorkingDir: string | null;
  parallelStatus: string | null;
};

async function advanceVerification(
  project: VerifyProject,
  slack: SlackTarget | null,
): Promise<TickResult> {
  if (!isExecHost()) return { status: "no_op", reason: "exec_host_only" };
  const projectId = project.id;
  const sentinel = await prisma.document.findFirst({
    where: { projectId, type: "verification" },
    orderBy: { createdAt: "desc" },
  });

  // needs_review：override(✅/承認) → done ／ 再検証 → verifying。
  if (project.parallelStatus === "needs_review") {
    if (!sentinel) return { status: "no_op", reason: "verify_no_sentinel" };
    const ch = slack?.channel ?? approvalChannel();
    const ts = sentinel.humanQuestionTs;
    if (ts) {
      const replies = await readUserReplies(ts, ch);
      const reverify = replies.some((r) => /再検証|recheck|re-?verify/i.test(r));
      const approve = replies.some((r) => /完了|承認|approve|done|ok/i.test(r));
      if (reverify) {
        await prisma.document.update({
          where: { id: sentinel.id },
          data: { executionStatus: "pending", execPid: null, execDoneFile: null, humanQuestionTs: null },
        });
        await prisma.project.updateMany({
          where: { id: projectId, parallelStatus: "needs_review" },
          data: { parallelStatus: "verifying" },
        });
        await notifySlack(slack, `🔁 *【${project.title}】再検証を開始*`).catch(() => {});
        return { status: "advanced", reason: "verifying" };
      }
      if (approve) {
        return await finalizeOverrideDone(project, slack, sentinel.id, "reply:承認");
      }
      const r = await checkReactionOnce(ts, ch);
      if (r === "approved") return await finalizeOverrideDone(project, slack, sentinel.id, "reaction:✅");
    }
    return { status: "no_op", reason: "needs_review_waiting" };
  }

  // verifying：4層検証
  const cwd = project.parallelWorkingDir;
  if (!cwd) return await finalizeNeedsReview(project, slack, sentinel?.id ?? null, ["作業ディレクトリ未設定で検証不能"]);
  const sid =
    sentinel?.id ??
    (await prisma.document.create({
      data: { projectId, type: "verification", title: "検証", content: "", executionStatus: "pending" },
      select: { id: true },
    })).id;
  const st = sentinel?.executionStatus ?? "pending";

  if (st === "pending") {
    const ch = detectChanges(cwd); // 層①：変更検知
    if (!ch.changed) return await finalizeNeedsReview(project, slack, sid, [`変更未検出: ${ch.summary}`]);
    const bp = detectBoilerplate(cwd); // 層①.5：ボイラープレート検知（決定論）
    if (bp.isBoilerplate) return await finalizeNeedsReview(project, slack, sid, bp.reasons);
    const b = runBuildCheck(cwd); // 層②：build（detached）
    await prisma.document.update({
      where: { id: sid },
      data: { executionStatus: "build_running", execPid: b.pid, execDoneFile: b.doneFile, executionLog: `[verify] build pid=${b.pid}` },
    });
    console.log(`[TICK] project=${projectId} verify: 層①/①.5 OK → build 起動`);
    return { status: "advanced", reason: "verify_progress" };
  }

  if (st === "build_running") {
    const inspect = await inspectExec(sentinel?.execDoneFile ?? "", sentinel?.execPid ?? null);
    if (inspect.status === "running") return { status: "no_op", reason: "verify_build_running" };
    if (inspect.status === "failed") {
      return await finalizeNeedsReview(project, slack, sid, ["ビルド失敗", (inspect.log || "").slice(-800)]);
    }
    // build success → 層③ critic
    const [reqDoc, sprintDoc] = await Promise.all([
      prisma.document.findFirst({ where: { projectId, type: "requirements" }, orderBy: { createdAt: "desc" } }),
      prisma.document.findFirst({ where: { projectId, type: "sprint" }, orderBy: { createdAt: "desc" } }),
    ]);
    const accCwd = await ensureAccessibleCwd(cwd).catch(() => null);
    if (!accCwd) return await finalizeNeedsReview(project, slack, sid, ["critic 用 cwd アクセス不可"]);
    let spawned;
    try {
      spawned = await startClaudeCodeDetached(
        buildCriticPrompt(reqDoc?.content ?? "", sprintDoc?.content ?? "", accCwd),
        accCwd,
        "検証critic",
      );
    } catch (e) {
      return await finalizeNeedsReview(project, slack, sid, [`critic 起動失敗: ${e instanceof Error ? e.message : String(e)}`]);
    }
    await prisma.document.update({
      where: { id: sid },
      data: { executionStatus: "critic_running", execPid: spawned.pid, execDoneFile: spawned.doneFile, executionLog: `[verify] critic pid=${spawned.pid}` },
    });
    console.log(`[TICK] project=${projectId} verify: 層②build OK → critic 起動`);
    return { status: "advanced", reason: "verify_progress" };
  }

  if (st === "critic_running") {
    const inspect = await inspectExec(sentinel?.execDoneFile ?? "", sentinel?.execPid ?? null);
    if (inspect.status === "running") return { status: "no_op", reason: "verify_critic_running" };
    const verdict = parseVerifyVerdict(inspect.log ?? ""); // 層③：parse 失敗=fail 安全側
    if (verdict.verdict === "pass") return await finalizeVerifiedDone(project, slack, sid);
    return await finalizeNeedsReview(project, slack, sid, verdict.reasons.length ? verdict.reasons : ["critic: fail（理由なし）"]);
  }

  return { status: "no_op", reason: "verify_unknown_state" };
}

// 検証クリーン → 完了。sentinel passed、markProjectDone（parallelStatus=done）、✅ 通知。
async function finalizeVerifiedDone(
  project: VerifyProject,
  slack: SlackTarget | null,
  sentinelId: string,
): Promise<TickResult> {
  await prisma.document.update({ where: { id: sentinelId }, data: { executionStatus: "passed" } }).catch(() => {});
  await notifySlack(slack, `✅ *【${project.title}】検証OK*（変更/ボイラープレート/ビルド/批評すべて通過）`).catch(() => {});
  await markProjectDone(project.id, project.title, slack);
  console.log(`[TICK] project=${project.id} verify → done`);
  return { status: "advanced", reason: "verified_done" };
}

// 検証で問題 → needs_review。理由を sentinel に記録、🔎 通知（ts を override poll 用に保持）。自動進行しない。
async function finalizeNeedsReview(
  project: VerifyProject,
  slack: SlackTarget | null,
  sentinelId: string | null,
  reasons: string[],
): Promise<TickResult> {
  const reasonText = reasons.filter(Boolean).join("\n- ");
  await prisma.project.updateMany({
    where: { id: project.id, parallelStatus: { in: ["verifying", "running"] } },
    data: { parallelStatus: "needs_review" },
  });
  const ts = await notifySlack(
    slack,
    `🔎 *【${project.title}】検証で要確認*\n- ${reasonText}\n（修正後にスレッドで「再検証」、問題なければ ✅ で完了承認）`,
  ).catch(() => "");
  if (sentinelId) {
    await prisma.document
      .update({
        where: { id: sentinelId },
        data: {
          executionStatus: "needs_review",
          humanQuestion: reasonText.slice(0, 4000), // 用途：検証の要確認理由（reasons）
          humanQuestionTs: ts || null,
          humanAskedAt: new Date(),
          execPid: null,
          execDoneFile: null,
        },
      })
      .catch(() => {});
  }
  console.log(`[TICK] project=${project.id} verify → needs_review`);
  return { status: "advanced", reason: "needs_review" };
}

// 人間 override（✅/承認 reply）→ done。
async function finalizeOverrideDone(
  project: VerifyProject,
  slack: SlackTarget | null,
  sentinelId: string,
  how: string,
): Promise<TickResult> {
  await prisma.document
    .update({ where: { id: sentinelId }, data: { executionStatus: "overridden", humanAnswer: how.slice(0, 200) } })
    .catch(() => {});
  await notifySlack(slack, `✅ *【${project.title}】人間レビューで完了承認*（${how}）`).catch(() => {});
  await markProjectDone(project.id, project.title, slack);
  console.log(`[TICK] project=${project.id} needs_review → override done (${how})`);
  return { status: "advanced", reason: "verified_done" };
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
      withHitlPreamble(next.content),
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

  // needs_human: claude が [[ASK_HUMAN]] で人間判断を要求 → completed にせず needs_human へ。
  // 質問/選択肢を保存。Slack 投稿・回答待ち・再 spawn は advanceWaitingForHuman が担当。
  if (status === "needs_human") {
    const q = inspect.ask?.q ?? "(質問本文の取得に失敗)";
    const choices = inspect.ask?.choices ?? [];
    const claimed = await prisma.document.updateMany({
      where: { id: next.id, executionStatus: "executing" },
      data: {
        executionStatus: "needs_human",
        humanQuestion: q,
        humanChoices: choices as unknown as object,
        humanQuestionTs: null,
        humanAnswer: null,
        humanAskedAt: null,
        humanRenotifiedAt: null,
        // 質問した claude プロセスは [[ASK_HUMAN]] 出力後に exit 済み。stale な
        // execPid/doneFile を残すと advanceWaitingForHuman の再spawn claim
        // (execPid=null 条件) が回答到着後に弾かれ、永久に再開しない。ここでクリアする。
        execPid: null,
        execStartedAt: null,
        execDoneFile: null,
      },
    });
    if (claimed.count === 0) return { status: "no_op", reason: "claim_lost" };
    console.log(`[TICK] Part${next.partNumber} → needs_human: ${q.slice(0, 80)}`);
    return { status: "advanced", reason: "needs_human" };
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
  status: "running" | "success" | "failed" | "needs_human";
  exitCode: number | null;
  logFile: string;
  log: string;
  logSize: number;
  ask: { q: string; choices: string[] } | null; // [[ASK_HUMAN]] 検出時の質問
}

// parseAskHuman は ./ask-human に切り出し（純粋関数・単体テスト可）。import は冒頭参照。

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

  const ask = parseAskHuman(log);
  let status: ExecInspect["status"];
  if (doneExists) {
    // claude が [[ASK_HUMAN]] で質問して停止した場合は exit code に関わらず needs_human を優先。
    if (ask) status = "needs_human";
    else status = exitCode === 0 ? "success" : "failed";
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
    `[RUNNER] checkClaudeCode runId=${runId} doneFile=${doneFile} logFile=${logFile} exitCode=${exitCode} logSize=${logSize} status=${status}${ask ? " ASK_HUMAN" : ""}`,
  );
  return { status, exitCode, logFile, log, logSize, ask };
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
