// Claude Code 並列実行ワーカー
//
// parallel-tick.ts の processOneTick() を 5 秒ごとにポーリングし、
// running 状態の全プロジェクトのステートマシンを進める常駐スクリプト。
// VM 上で `npm run worker` として PM2 / systemd 配下で動かす想定。

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import {
  findRunnableProjects,
  processOneTick,
  recoverFromCrash,
  recoverStaleSpawnClaims,
  resumeStuckProjects,
} from "../lib/parallel-tick";
import { prisma } from "../lib/prisma";

// 起動権センチネル(execPid=-1)を握ったまま spawn 途中で死んだ取り残しを
// 稼働中も解放する猶予（正常な execPid=-1 はサブ秒なので 2 分で十分）。
const SPAWN_CLAIM_STALE_MS = 2 * 60 * 1000;

const TICK_INTERVAL_MS = 5_000;

// ヘルスチェック用 HTTP サーバ。Cloud Monitoring Uptime Check / systemd 監視から参照。
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 3001);
const HEALTH_HOST = process.env.HEALTH_HOST ?? "0.0.0.0";
// systemd watchdog ping 間隔。unit の WatchdogSec=60s に対し半分の周期で叩く。
const WATCHDOG_INTERVAL_MS = 30_000;
// 直近 tick が「新鮮」とみなせる上限。これを超えるとハング疑いで degraded 扱い。
const TICK_FRESH_MS = 60_000;

const processStartedAt = Date.now();

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

// /health で公開する直近 tick の状態。
let lastTickStartedAt: number | null = null;
let lastTickFinishedAt: number | null = null;
let lastTickErrors = 0;

async function runOneTick(): Promise<void> {
  const tickId = Date.now();
  lastTickStartedAt = tickId;
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
      // allowScaffold=true は VM worker のこのポーリングのみ。Cloud Run の
      // fireAndForgetTick / tick route は false のまま（scaffold は VM 限定）。
      projects.map((p) => processOneTick(p.id, { allowScaffold: true })),
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

  lastTickFinishedAt = Date.now();
  lastTickErrors = errors;
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

async function checkDbConnected(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /health → { status, last_tick, db_connected, ... }。
 * status は db 接続と直近 tick の鮮度で判定し、健全=200 / 異常=503 を返す
 * （Cloud Monitoring Uptime Check / ロードバランサのヘルスチェック前提）。
 */
function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || !req.url || !req.url.startsWith("/health")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void (async () => {
      const dbConnected = await checkDbConnected();
      const now = Date.now();
      const tickFresh =
        lastTickFinishedAt !== null && now - lastTickFinishedAt < TICK_FRESH_MS;
      // 起動直後（初回 tick 未完了）は猶予として fresh 扱い。
      const startingUp =
        lastTickFinishedAt === null && now - processStartedAt < TICK_FRESH_MS;
      const healthy = dbConnected && (tickFresh || startingUp);
      const body = {
        status: healthy ? "ok" : "degraded",
        last_tick:
          lastTickFinishedAt !== null
            ? new Date(lastTickFinishedAt).toISOString()
            : null,
        db_connected: dbConnected,
        last_tick_errors: lastTickErrors,
        shutting_down: shuttingDown,
        uptime_s: Math.floor((now - processStartedAt) / 1000),
      };
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    })().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: msg }));
    });
  });
  server.on("error", (e) => {
    console.error(`[WORKER] health server error: ${e.message}`);
  });
  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    console.log(`[WORKER] health endpoint on http://${HEALTH_HOST}:${HEALTH_PORT}/health`);
  });
}

/**
 * systemd sd_notify。Type=notify + NotifyAccess=all の unit 配下でのみ作用する。
 * NOTIFY_SOCKET が無い（PM2 / 手動起動）場合は no-op。Node は AF_UNIX SOCK_DGRAM を
 * 直接扱えないため systemd-notify(1) に委譲する。systemd-notify 不在でも
 * Restart=on-failure は機能するので致命的ではない。
 */
function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  execFile("systemd-notify", [state], (err) => {
    if (err) {
      console.error(`[WORKER] systemd-notify ${state} failed: ${err.message}`);
    }
  });
}

function startWatchdog(): void {
  if (!process.env.NOTIFY_SOCKET) {
    console.log("[WORKER] NOTIFY_SOCKET unset; systemd watchdog disabled");
    return;
  }
  console.log(`[WORKER] systemd watchdog ping every ${WATCHDOG_INTERVAL_MS}ms`);
  const timer = setInterval(() => {
    // DB に到達できる間だけ keep-alive を送る。到達不能なら ping を止めて
    // WatchdogSec 経過で systemd に再起動させる（ハング検知）。
    void checkDbConnected().then((ok) => {
      if (ok && !shuttingDown) sdNotify("WATCHDOG=1");
    });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
}

async function main(): Promise<void> {
  requireEnv("DATABASE_URL");
  requireEnv("ANTHROPIC_API_KEY");

  setupSignalHandlers();
  startHealthServer();

  console.log(`[WORKER] started (tick interval=${TICK_INTERVAL_MS}ms)`);

  try {
    await recoverFromCrash();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ERROR] recoverFromCrash failed:`, msg);
  }

  // 初期化完了を systemd に通知してから watchdog ping を開始する。
  sdNotify("READY=1");
  startWatchdog();

  await loop();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[ERROR] worker crashed:`, msg);
  process.exit(1);
});
