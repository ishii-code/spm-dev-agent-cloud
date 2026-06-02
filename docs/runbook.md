# 運用ランブック — spm-dev-agent

## 緊急連絡・エスカレーション

| 役割 | 担当 | 連絡 |
|------|------|------|
| 一次対応 / オーナー | ごう（石井豪） | Slack DM / gou.ishii@gmail.com |
| アラート先 | #monitoring（Slack） | Cloud Monitoring から自動通知 |
| エスカレーション | PECO 開発チーム | #spm-dev |

> 患者個人情報を Slack やログに貼らないこと。再現データは Faker 等の架空データを使う。

## 障害対応シナリオ

### 1. Worker 停止 / ハング

**検知**: 「claude-worker spawn/OpenAI 失敗検出」アラート、または Worker `/health` が 503 / 無応答、UI でプロジェクトが進まない。

```bash
sudo scripts/vm-logs.sh status
sudo scripts/vm-logs.sh errors worker 30
curl -s localhost:3001/health | jq .
```

- `db_connected:false` → DB 障害（シナリオ 3 へ）。
- `last_tick` が数分前で止まる → ハング。`Type=notify`+`WatchdogSec=60` で systemd が自動再起動しているはず。手動再起動: `sudo systemctl restart spm-dev-agent-worker`。
- 連続クラッシュ（`Restart=on-failure` でループ）→ `journalctl -u spm-dev-agent-worker -n 200` で原因確認。多くは env 不足（`DATABASE_URL`/`ANTHROPIC_API_KEY`）か `SPM_PROJECTS_ROOT`/`CLAUDE_BIN` の解決失敗。

### 2. OpenAI / Anthropic API キー切れ・レート

**検知**: `[ORCHESTRATOR] OpenAI呼出失敗`、Claude Code spawn 後すぐ error、401/429。

- キー確認: `sudo systemctl show spm-dev-agent-worker -p Environment`（値は伏せて存在確認）。`/etc/spm-dev-agent/worker.env` を更新。
- ローテーション後: `sudo systemctl restart spm-dev-agent-worker`、Cloud Run 側は `gcloud run services update spm-dev-agent-web --update-secrets=...`。
- レート超過は一時的。バックオフを待ち、多発ならプラン/並列度を見直す。

### 3. DB 接続失敗

**検知**: `/health` `db_connected:false`、Prisma `P1010`/接続タイムアウト。

- Cloud SQL Auth Proxy が起動しているか（VM）: `sudo systemctl status cloud-sql-proxy`。
- TLS 必須 DB で平文接続して拒否 → `DATABASE_SSL_CA`/`PGSSLROOTCERT` を設定（`prisma.ts` が CA ありで検証接続）。
- 接続数枯渇 → Cloud SQL のアクティブ接続を確認、worker/web の同時実行を抑制。
- 疎通確認: `psql "$DATABASE_URL" -c 'select 1'`。

### 4. Slack DM 承認が届かない

- `SKIP_APPROVAL=true` になっていないか（なっていれば承認なしで実行される）。
- Bot トークン未設定 → トークンが無いとデッドロック回避で自動承認になる。`SLACK_BOT_TOKEN` を確認。
- DM が来ない → `Project.creatorSlackId` 未設定だと共有 `SLACK_APPROVAL_CHANNEL` に届く。DM には Bot に `im:write` スコープが必要。
- それでも来ない → `SLACK_APPROVAL_CHANNEL`（既定 `C0B3D1S0LER`）とプロジェクトスレッドを確認。

## 並列実行のデバッグ（psql 1 ライナー）

`psql "$DATABASE_URL"` で接続。

```sql
-- 全 Project の並列実行状態
SELECT id, title, "parallelStatus", "parallelRunId", "parallelDoneNotifiedAt", "archivedAt"
FROM "Project" ORDER BY "updatedAt" DESC;

-- 全 sprint_part の実行状態
SELECT id, "projectId", "partNumber", "partTitle", "executionStatus", "approvalState", "execPid"
FROM "Document" WHERE type = 'sprint_part' ORDER BY "projectId", "partNumber";

-- 特定パートの状態とログ
SELECT "executionStatus", "approvalState", "executionLog", "execPid"
FROM "Document" WHERE id = '<DOCUMENT_ID>';
```

### Part1 を再実行させる

```sql
UPDATE "Document"
SET "executionStatus"='waiting', "approvalState"=NULL, "execPid"=NULL,
    "execStartedAt"=NULL, "execDoneFile"=NULL, "slackApprovalTs"=NULL,
    "approvalPostedAt"=NULL, "notifiedStartAt"=NULL, "notifiedDoneAt"=NULL,
    "notifiedErrorAt"=NULL, "executedAt"=NULL, "retryCount"=0
WHERE "projectId"='<PROJECT_ID>' AND "partNumber"=1;
```

Project の `parallelStatus` は毎 tick の `resumeStuckProjects()` が自動で `running` に戻すため追加 SQL 不要（即時にしたいなら `UPDATE "Project" SET "parallelStatus"='running', "parallelDoneNotifiedAt"=NULL WHERE id='<PROJECT_ID>';`）。

### waiting ⇄ approved 無限ループ

ログに `phase=waiting -> advanced(approved)` が毎 tick 出て `executing` に進まない場合、起動権センチネル `execPid=-1` を握ったまま取り残されている。通常はワーカーが自動解放（起動時 `recoverStaleSpawnClaims(0)` / 稼働中 2 分）。即時解放：

```sql
UPDATE "Document" SET "execPid"=NULL, "execStartedAt"=NULL
WHERE "execPid"=-1 AND type='sprint_part';
```

## VM 環境変数のハマりどころ

- `SPM_PROJECTS_ROOT`: 未設定だと `os.homedir()` 基点。VM で macOS 由来の絶対パスが DB に残ると `spawn /bin/bash EACCES cwd=...` で失敗するため**必ず設定**。spawn 直前に cwd の R/W を検証し、不可なら `SPM_PROJECTS_ROOT/<repo>` にフォールバック（無ければ `mkdir -p`）。
- `CLAUDE_BIN`: 解決順 ①`CLAUDE_BIN` → ②`which claude` → ③失敗ならエラー。PATH 外（例 `~/.npm-global/bin/claude`）なら明示指定。

## 定期メンテナンス

- **キーローテーション**: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `SERVICE_API_KEY` / `AUTH_SECRET` を定期更新（worker.env と Cloud Run secrets 両方）。`SERVICE_API_KEY` は Work-Monitor と同値を保つ。
- **Cloud SQL バックアップ確認**: 自動バックアップの成否を月次で確認（`gcloud sql backups list --instance=...`）。
- **依存更新**: `npm audit` と Next/Prisma のセキュリティ更新。
- **モニタリング再適用**: メトリック/ポリシー変更時は `scripts/setup-monitoring.sh` を再実行（冪等）。
