This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Claude Code 並列実行ワーカー（VM 向け）

VM 上で常駐させる Claude Code 並列実行ワーカー。`parallel-tick.ts` の `processOneTick()` を 5 秒ごとに無限ループで呼び、`parallelStatus='running'` のプロジェクトを順次進行させる。Next.js サーバーとは独立したプロセスとして起動する。

### 必須環境変数

- `DATABASE_URL` — PostgreSQL 接続文字列（Prisma が利用）
- `ANTHROPIC_API_KEY` — Claude Code 実行に必要

未設定の場合は `[ERROR] required env var ... is not set` を出力して即終了する。

### 起動

```bash
npm run worker
```

起動時に `[WORKER] started` をログ出力し、各 tick で進行があれば `[TICK] processed N parts` を出力する。例外はキャッチして `[ERROR] ...` を出力し、プロセスは継続する。

### Graceful shutdown

`SIGINT` / `SIGTERM` を受信すると進行中の tick を待ってから `[WORKER] stopped` を出力して終了する。PM2 / systemd 配下で再起動させる運用を想定。

### PM2 起動例

```bash
pm2 start npm --name claude-worker -- run worker
pm2 save
```

### デバッグ用 1 ライナー SQL

`psql "$DATABASE_URL"` で接続して以下を実行する。

```sql
-- 全 Project の並列実行状態を確認
SELECT id, title, "parallelStatus", "parallelRunId", "parallelDoneNotifiedAt", "archivedAt"
FROM "Project"
ORDER BY "updatedAt" DESC;

-- 全 sprint_part Document の実行状態を確認
SELECT id, "projectId", "partNumber", "partTitle", "executionStatus", "approvalState", "execPid"
FROM "Document"
WHERE type = 'sprint_part'
ORDER BY "projectId", "partNumber";

-- 特定プロジェクトの Part1 だけを waiting にリセットして再実行させる
UPDATE "Document"
SET "executionStatus" = 'waiting',
    "approvalState"   = NULL,
    "execPid"         = NULL,
    "execStartedAt"   = NULL,
    "execDoneFile"    = NULL,
    "slackApprovalTs" = NULL,
    "approvalPostedAt"= NULL,
    "notifiedStartAt" = NULL,
    "notifiedDoneAt"  = NULL,
    "notifiedErrorAt" = NULL,
    "executedAt"      = NULL,
    "retryCount"      = 0
WHERE "projectId" = '<PROJECT_ID>' AND "partNumber" = 1;
```

Document を waiting に戻したあと、Project の `parallelStatus` が `'done'` / `NULL` のままでも、ワーカーが毎 tick `resumeStuckProjects()` を実行して自動で `'running'` に戻すため、追加のSQLは不要（手動で戻したい場合は `UPDATE "Project" SET "parallelStatus"='running', "parallelDoneNotifiedAt"=NULL WHERE id='<PROJECT_ID>';`）。

### Part が waiting ⇄ approved を無限ループするとき

ログに `phase=waiting -> advanced(approved)` が毎 tick 繰り返し出て、いつまでも
`executing` に進まない場合、当該パートが **起動権センチネル `execPid = -1`** を握ったまま
取り残されている（`advanceApproved` が spawn 権を確保した直後にワーカーが
クラッシュ／強制終了し、`executing` にも `error` にも確定できなかった状態）。
`execPid = -1` のパートは `approved` 分類（`execPid IS NULL` が条件）に戻れず spawn されず、
かつ `awaiting_approval` 分類へ落ちて `waiting` に巻き戻されるため無限ループになる。

まず状態を確認する（依頼で指定された 1 行 SQL）：

```sql
SELECT "executionStatus", "approvalState", "executionLog", "execPid"
FROM "Document" WHERE id = '<DOCUMENT_ID>';
```

- `execPid = -1` かつ `executionStatus = 'awaiting_approval'` なら本ループに該当。

通常は**ワーカーが自動復旧する**：

- 起動時に `recoverFromCrash()` → `recoverStaleSpawnClaims(0)` が残存 `-1` を全て解放。
- 稼働中も毎 tick `recoverStaleSpawnClaims(2分)` が `execStartedAt` の古い `-1` を解放。
- 解放後（`execPid = NULL`）、次 tick で `approved` 分類に復帰し再 spawn される。

手動で即座に解放したい場合：

```sql
-- 取り残された spawn claim を解放（再 spawn 対象に復帰）
UPDATE "Document"
SET "execPid" = NULL, "execStartedAt" = NULL
WHERE "execPid" = -1 AND type = 'sprint_part';
```

> 補足: `slackThreadTs` が未設定（Slack 連携なし）のプロジェクトでは、承認ステップを
> スキップして `approvalState='approved'` で直接 `approved` 分類に入り spawn される。
> spawn 自体が失敗する場合は `executionLog` に `[spawn失敗] ...` が記録され
> `executionStatus='error'` になる（こちらはループせず終了する別系統）。
