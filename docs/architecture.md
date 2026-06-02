# アーキテクチャ — spm-dev-agent

## 全体構成

```mermaid
flowchart TB
  subgraph Clients
    ADMIN[管理者ブラウザ]
    WM[Work-Monitor<br/>管理ダッシュボード]
  end

  subgraph GCP["GCP project: vets-biz-aigen-apps (asia-northeast1)"]
    subgraph CR["Cloud Run: spm-dev-agent-web"]
      WEB[Next.js<br/>UI + API Routes + middleware JWT]
    end
    subgraph VMB["GCE VM (i-β)"]
      WORKER[claude-worker<br/>5s tick]
      CC[Claude Code CLI x N<br/>spawn detached]
      WH[/health :3001/]
    end
    SQL[(Cloud SQL<br/>PostgreSQL)]
    LOG[Cloud Logging]
    MON[Cloud Monitoring<br/>Uptime + Alert]
  end

  SLACK[Slack 承認/通知]
  ANTHRO[Anthropic API]
  OPENAI[OpenAI API]

  ADMIN -->|cookie spm_dev_session| WEB
  WM -->|X-Service-Key| WEB
  WEB <-->|Prisma/adapter-pg| SQL
  WORKER <-->|Prisma/adapter-pg| SQL
  WORKER --> CC
  CC --> ANTHRO
  WORKER -->|orchestrator| OPENAI
  WORKER --> SLACK
  WEB --> SLACK
  WEB -.-> LOG
  WORKER -.-> LOG
  MON -->|uptime| WEB
  MON -->|alert| SLACK
  LOG --> MON
```

## データフロー（社員操作 → 成果物）

```mermaid
sequenceDiagram
  participant U as 社員/管理者
  participant WM as Work-Monitor
  participant WEB as spm-dev-agent-web
  participant DB as PostgreSQL
  participant WK as claude-worker (VM)
  participant CC as Claude Code
  participant SL as Slack

  U->>WM: 自動化提案を承認 → プロジェクト作成
  WM->>WEB: POST /api/projects (X-Service-Key, creatorSlackId)
  WEB->>DB: Project / Document(sprint_part) 作成 (parallelStatus=running)
  loop 5 秒ごと
    WK->>DB: findRunnableProjects / processOneTick
    WK->>SL: 承認リクエスト (DM or channel)
    SL-->>WK: ✅ リアクションで承認
    WK->>CC: spawn (該当パートを実装)
    CC->>DB: 実行ログ / 完了状態を更新
  end
  WK->>SL: 完了通知 (プロジェクトスレッド)
  U->>WEB: 成果物・ログを UI で確認
```

## コンポーネント責務

| コンポーネント | 実体 | 責務 |
|----------------|------|------|
| Web (Cloud Run) | `src/app/**`, `src/middleware.ts` | UI 配信、API（プロジェクト CRUD / 実行トリガ / 認証 / health）、JWT セッション検証、`X-Service-Key` 検証 |
| Worker (VM) | `src/workers/claude-worker.ts` | tick ループ、クラッシュ復旧、stale spawn claim 解放、health/ watchdog |
| 並列実行エンジン | `src/lib/parallel-tick.ts` | パートのステートマシン（waiting→approved→executing→done/error）、Claude Code spawn、Slack 承認連携 |
| DB アクセス | `src/lib/prisma.ts` | Prisma クライアント（pg adapter）、接続先に応じた TLS 解決 |
| サービス認証 | `src/lib/api-auth.ts` | `X-Service-Key` の timing-safe 比較 |
| ヘルス | `src/app/api/health/route.ts` / worker 内 HTTP | DB 到達性・直近 tick 鮮度の公開 |

## 信頼性の仕組み

- **Worker watchdog**: `Type=notify` + `WatchdogSec=60`。worker は DB 到達可能な間だけ 30s ごとに `WATCHDOG=1` を送る。ハング（DB 不能/フリーズ）で ping が止まると systemd が再起動。
- **クラッシュ復旧**: 起動時 `recoverFromCrash()` + `recoverStaleSpawnClaims(0)`、稼働中も毎 tick `recoverStaleSpawnClaims(2分)` / `resumeStuckProjects()`。
- **ヘルスチェック**: Web/Worker とも `/health` を持ち、DB 不能時は 503。Cloud Monitoring Uptime Check と LB ヘルスチェックに利用。
- **アラート**: Cloud Logging メトリック（web ERROR 数 / worker 失敗数）→ アラートポリシー → Slack #monitoring。
