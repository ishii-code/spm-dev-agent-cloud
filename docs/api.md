# 内部 API — spm-dev-agent

ベース URL: `https://spm-dev-agent-web-<...>.asia-northeast1.run.app`（本番 Cloud Run）/ `http://localhost:3005`（dev）。

## 認証方式

| 方式 | ヘッダ/Cookie | 用途 |
|------|---------------|------|
| セッション (JWT) | Cookie `spm_dev_session` | ブラウザ UI からの操作。`src/middleware.ts` / 各ルートで検証 |
| サービス間 | ヘッダ `X-Service-Key` | 他サービス（Work-Monitor）からのプロジェクト作成。`SERVICE_API_KEY` と timing-safe 比較 |
| なし | — | `/api/health`, `/api/auth/login` |

エラーレスポンスはスタックトレースを含めない。必須欠落=400 / 未認証=401 / 未存在=404 / 競合=409。

## エンドポイント一覧

| メソッド | パス | 認証 | 概要 |
|----------|------|------|------|
| GET | `/api/health` | なし | DB 到達性ヘルスチェック（uptime 用） |
| POST | `/api/auth/login` | なし | ログイン（JWT 発行） |
| POST | `/api/auth/logout` | session | ログアウト |
| GET | `/api/auth/me` | session | 現在ユーザー |
| POST | `/api/projects` | X-Service-Key または session | プロジェクト作成 |
| GET | `/api/projects/[id]` | session | プロジェクト詳細 |
| POST | `/api/chat` | session | Claude チャット |
| POST | `/api/execute` | session | ドキュメント実行 |
| POST | `/api/execute/parallel` | session | 並列実行トリガ |
| GET | `/api/execute/parallel/tick` | session | tick 状態 |
| GET | `/api/systems/status` | session | 各システム稼働状態 |
| GET | `/api/portfolio/[id]` | session | ポートフォリオ |
| POST | `/api/portfolio/[id]/mapping` | session | ポートフォリオ割当 |
| GET | `/api/portfolio/changelog` | session | 変更履歴 |

## 主要エンドポイント詳細

### GET /api/health

```http
GET /api/health
```

200（正常） / 503（DB 不能）:

```json
{ "status": "ok", "db_connected": true, "time": "2026-06-02T01:23:45.000Z" }
```

### POST /api/projects

Work-Monitor からの自動作成はこのエンドポイントを `X-Service-Key` で叩く。

```http
POST /api/projects
X-Service-Key: <SERVICE_API_KEY>
Content-Type: application/json

{
  "title": "[山田太郎] Slack 返信下書き Bot",
  "description": "作業内容の説明",
  "projectType": "new",
  "targetSystem": "wm-dev_tools-1717290000",
  "businessCategory": "dev_tools",
  "creatorSlackId": "U01ABC23XYZ",
  "source": "pc-work-monitor"
}
```

レスポンス（201）:

```json
{ "project": { "id": "clxxxx..." } }
```

- `creatorSlackId` があると承認リクエストが本人 DM に届く（無い場合は共有チャンネル）。
- `X-Service-Key` 不一致は 401。

## Worker ヘルスエンドポイント（VM 内部）

Cloud Run の API ではなく VM 上 worker が公開する別ポート。

```http
GET http://localhost:3001/health
```

200 / 503:

```json
{
  "status": "ok",
  "last_tick": "2026-06-02T01:23:40.000Z",
  "db_connected": true,
  "last_tick_errors": 0,
  "shutting_down": false,
  "uptime_s": 3600
}
```
