// Claude Code 並列実行ワーカー
//
// parallel-tick.ts の processOneTick() を 5 秒ごとにポーリングし、
// running 状態の全プロジェクトのステートマシンを進める常駐スクリプト。
// VM 上で `npm run worker` として PM2 / systemd 配下で動かす想定。

import {
  findRunnableProjects,
  processOneTick,
  recoverFromCrash,
  recoverStaleSpawnClaims,
  resumeStuckProjects,
} from "../lib/parallel-tick";

// 起動権センチネル(execPid=-1)を握ったまま spawn 途中で死んだ取り残しを
// 稼働中も解放する猶予（正常な execPid=-1 はサブ秒なので 2 分で十分）。
const SPAWN_CLAIM_STALE_MS = 2 * 60 * 1000;

const TICK_INTERVAL_MS = 5_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[ERROR] required env var ${name} is not set`);
    process.exit(1);
  }
  return v;
}

let shuttingDown = false;
let currentTick: Promise<void> | null = null;

async function runOneTick(): Promise<void> {
  const tickId = Date.now();
  let errors = 0;
  console.log(`[TICK] start tick=${tickId}`);

  // spawn 途中で取り残された execPid=-1（stale spawn claim）を解放して再 spawn 可能に。
  // これを怠ると当該パートは approved 分類に戻れず waiting⇄awaiting_approval を無限ループする。
  try {
    await recoverStaleSpawnClaims(SPAWN_CLAIM_STALE_MS);
  } catch (e) {
    errors++;
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : "";
    console.error(`[ERROR] recoverStaleSpawnClaims failed: ${msg}\n${stack ?? ""}`);
  }

  // 非終端 Document を持つのに parallelStatus が 'running' でない "取り残し" を自動復旧。
  let resumed = 0;
  try {
    resumed = await resumeStuckProjects();
  } catch (e) {
    errors++;
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : "";
    console.error(`[ERROR] resumeStuckProjects failed: ${msg}\n${stack ?? ""}`);
  }
  console.log(`[TICK] resumed ${resumed} stuck projects`);

  let projects: { id: string }[] = [];
  try {
    projects = await findRunnableProjects();
  } catch (e) {
    errors++;
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : "";
    console.error(`[ERROR] findRunnableProjects failed: ${msg}\n${stack ?? ""}`);
  }
  console.log(`[TICK] found ${projects.length} runnable projects`);

  let advanced = 0;
  if (projects.length > 0) {
    const settled = await Promise.allSettled(
      projects.map((p) => processOneTick(p.id)),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        if (r.value.status === "advanced") advanced++;
      } else {
        errors++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`[ERROR] processOneTick rejected: ${msg}`);
      }
    }
  }
  console.log(`[TICK] processed ${advanced} parts`);
  console.log(`[TICK] end tick=${tickId} errors=${errors}`);
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    currentTick = runOneTick().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ERROR] tick failed:`, msg);
    });
    await currentTick;
    currentTick = null;
    if (shuttingDown) break;
    await sleep(TICK_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const onSignal = () => {
      clearTimeout(t);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function setupSignalHandlers(): void {
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[WORKER] received ${sig}, shutting down gracefully`);
    Promise.resolve(currentTick)
      .catch(() => {})
      .finally(() => {
        console.log(`[WORKER] stopped`);
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  requireEnv("DATABASE_URL");
  requireEnv("ANTHROPIC_API_KEY");

  setupSignalHandlers();

  console.log(`[WORKER] started (tick interval=${TICK_INTERVAL_MS}ms)`);

  try {
    await recoverFromCrash();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ERROR] recoverFromCrash failed:`, msg);
  }

  await loop();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[ERROR] worker crashed:`, msg);
  process.exit(1);
});
