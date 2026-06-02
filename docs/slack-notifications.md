# Slack 通知一覧とメンション必須仕様

## メンション必須

全 Slack 通知は冒頭に **`<@U0AMRAQDW65>`**（`SLACK_MENTION_USER_ID`）を自動付与する。
実装は `src/lib/slack.ts` の `withMention()` / `mentionPrefix()` / `sendSlackWithMention()` に集約され、
既存の送信チョークポイントが全てこれを通る。

| 送信元 | 関数 | チョークポイント | メンション |
|--------|------|----------------|-----------|
| `src/lib/slack-notifier.ts` | notifyExecutionStart / notifyThread / notifyComplete / notifySecurityApproval | `postSlack` / `postSlackBlocks` → `withMention()` | ✅ |
| `src/lib/slack-approval.ts` | postSlackTo / postSlackThread / waitForReactionApproval / waitForSlackChoice 等 | `postMessage` → `withMention()` | ✅ |
| `src/lib/slack.ts` | `sendSlackWithMention(channelOrUserId, msg)` | 直接 `withMention()` | ✅ |
| `scripts/ask-human.sh` | HITL 質問 DM | メッセージ先頭に `<@U0AMRAQDW65>` | ✅ |

> `withMention()` は二重付与を防ぐ（既に `<@...>` で始まる本文はそのまま）。

## 通知の種類

| 通知 | 宛先 | 内容 |
|------|------|------|
| 開発開始 | 共有チャンネル(C0B3D1S0LER) | `🚀 【プロジェクト名】開発開始` + 対象リポ |
| スレッド進捗 / 完了 | プロジェクトスレッド | `✅/❌ 実装完了/エラー` + 所要時間 |
| セキュリティ承認 | スレッド | ⚠️ 承認/拒否ボタン（block kit） |
| Part 承認依頼 | 作成者 DM（`creatorSlackId`）or 共有 | リアクション ✅/❌ で承認 |
| HITL 確認 | 作成者/ごうさん DM | `scripts/ask-human.sh`。👍/✅=A, 👎/❌=B, 返信=詳細 |

## 環境変数

| 変数 | 用途 |
|------|------|
| `SLACK_BOT_TOKEN` | 送信・リアクション取得（`chat:write` / `reactions:read` / `im:write`） |
| `SLACK_MENTION_USER_ID` | メンション対象（既定 `U0AMRAQDW65`） |
| `SLACK_APPROVAL_CHANNEL` | 共有承認チャンネル（既定 `C0B3D1S0LER`） |
| `SKIP_APPROVAL` | `true` で承認スキップ（開発用） |
