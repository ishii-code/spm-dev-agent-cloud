# spm-dev-agent クラウド版 — Claude セッションコンテキスト

## 概要
ローカル `~/spm-dev-agent`（個人運用）を社員向けクラウド展開した版。
GCP 上で複数社員が並列開発できるよう、Web 本体と Claude Code 実行環境を 1 つの GCE VM に集約する（i-β アーキテクチャ）。

## リソース
- リポジトリ: `peco-vets/spm-dev-agent-cloud`（**暫定 `ishii-code/spm-dev-agent-cloud` private**。peco-vets Pro 化後に transfer 予定）
- GCP プロジェクト: `vets-biz-aigen-apps`（リージョン `asia-northeast1`、project number 842623777962）
- Billing: `billingAccounts/0129DE-D05086-F76885`（会社カード、SFA と同居）
- ローカル: `~/workspace/spm-dev-agent-cloud/`

## 現在 Phase 1.2 — Dockerfile + .dockerignore + ビルド確認

目標:
1. Dockerfile / .dockerignore を作成 ✅（このコミットで完了）
2. ローカル `docker build` ／ Cloud Build で疎通 ← 次セッション
3. commit / push ✅（このコミットで完了）

## コスト制約
- GCE VM: `e2-medium`（NOT e2-standard-4）
- Cloud SQL: `db-f1-micro`
- Anthropic API: 月 $100 ハード上限
- OpenAI API: 月 $50 ハード上限
- GCP Budget Alert: 月 5 万円で 50/80/100% Slack 通知

## 詳細参照（必要時のみ読む）
Obsidian Vault は Google Drive 同期。実体パスは以下：
- 実装ログ: `~/Library/CloudStorage/GoogleDrive-takeshi.ishii@peco-japan.com/マイドライブ/Obsidian Vault/開発プロジェクト/spm-dev-agent-cloud/03_実装ログ.md`
- 依頼内容: 同フォルダ `00_依頼内容.md`
- 全体設計（叩き台）: Slack canvas — **本セッションでは読まない**（コスト重）

## 注意
- 詳細仕様・設計議論は Obsidian / Slack canvas に集約。本ファイルはクラウド版開発時の最小コンテキストのみ。
- Phase 1.2 を超える話題が出た場合は実装ログを先に参照する。
- 既存 `AGENTS.md` はローカル版コピー由来の医療法対応セクション。クラウド版用書き換えは引き継ぎ事項。
