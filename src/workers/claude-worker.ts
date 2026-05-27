// Claude Code 並列実行ワーカー
//
// parallel-tick.ts の processOneTick() を 5 秒ごとにポーリングし、
// running 状態の全プロジェクトのステートマシンを進める常駐スクリプト。
// VM 上で `npm run worker` として PM2 / systemd 配下で動かす想定。

import {
  findRunnableProjects,
  processOneTick,
  recoverFromCrash,
} from "../lib/parallel-tick";

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
  const projects = await findRunnableProjects();
  if (projects.length === 0) {
    return;
  }

  const settled = await Promise.allSettled(
    projects.map((p) => processOneTick(p.id)),
  );

  let advanced = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") {
      if (r.value.status === "advanced") advanced++;
    } else {
      console.error(`[ERROR] processOneTick rejected:`, r.reason);
    }
  }

  if (advanced > 0) {
    console.log(`[TICK] processed ${advanced} parts`);
  }
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
