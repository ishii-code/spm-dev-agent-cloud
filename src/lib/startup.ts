import { prisma } from "./prisma";
import {
  fireAndForgetTick,
  findRunnableProjects,
  recoverFromCrash,
} from "./parallel-tick";

const HEALTH_INTERVAL_MS = 10 * 60 * 1000; // 10 分
const EXEC_HARD_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 時間

// サーバー起動時の総合復旧
//   1) recoverFromCrash: ロック解放 + executing パートを checkClaudeCode で再分類
//   2) findRunnableProjects: parallelStatus='running' の各プロジェクトに対し
//      fireAndForgetTick で tick を再駆動
//   3) startOrphanHealthCheck: 孤児プロセスを定期的に kill する保険
// ※ 旧 cleanupStuckExecutions（updatedAt 1h で executing→error 強制）は
//   新ステートマシンと衝突するため廃止。長時間実行は tick D-branch の
//   3時間タイムアウトで個別に kill 判定される。
export async function performStartupRecovery(): Promise<void> {
  await recoverFromCrash();
  const runnable = await findRunnableProjects();
  if (runnable.length > 0) {
    console.log(`[STARTUP] ${runnable.length} 件の並列実行を再開します`);
    for (const p of runnable) {
      fireAndForgetTick(p.id);
    }
  }
  startOrphanHealthCheck();
}

// =============================================================================
// 孤児プロセス対策（保険）：10分ごとに executing パートの execPid を点検し、
// 3時間超で執行中のものは SIGKILL → DB を再実行可能状態に戻す
// =============================================================================

let healthTimer: NodeJS.Timeout | null = null;

export function startOrphanHealthCheck(): void {
  if (healthTimer) return; // 多重登録防止
  healthTimer = setInterval(runHealthCheck, HEALTH_INTERVAL_MS);
  console.log(
    `[HEALTH] 孤児プロセス監視を開始しました（${HEALTH_INTERVAL_MS / 60000}分間隔）`,
  );
}

async function runHealthCheck(): Promise<void> {
  try {
    const execs = await prisma.document.findMany({
      where: { type: "sprint_part", executionStatus: "executing" },
      select: { id: true, execPid: true, execStartedAt: true },
    });
    const now = Date.now();
    for (const e of execs) {
      const tooOld =
        e.execStartedAt != null &&
        now - e.execStartedAt.getTime() > EXEC_HARD_TIMEOUT_MS;
      if (e.execPid != null && tooOld) {
        try {
          process.kill(e.execPid, "SIGKILL");
        } catch {
          // already dead
        }
        await prisma.document.update({
          where: { id: e.id },
          data: {
            executionStatus: "awaiting_approval",
            approvalState: "approved",
            execPid: null,
            execStartedAt: null,
            execDoneFile: null,
          },
        });
        console.log(`[HEALTH] 孤児プロセス kill: pid=${e.execPid}`);
      }
    }
  } catch (err) {
    console.error("[HEALTH] check failed:", err);
  }
}
