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
