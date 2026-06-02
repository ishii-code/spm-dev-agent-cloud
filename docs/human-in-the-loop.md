# Human-in-the-Loop (HITL) — 重要判断は人間に確認する

## 設計思想

spm-dev-agent が spawn する Claude Code は自律実行するが、**不可逆・高リスク・法令関連・仕様曖昧**な
判断を AI 単独で行わない。該当時は `scripts/ask-human.sh` で **Slack DM（必ずメンション付き）**により
人間（ごうさん, `U0AMRAQDW65`）へ確認し、回答を待ってから進む。

- スキル定義: `spm-medical-pack/skills/spm-human-in-the-loop/SKILL.md`（VM の `~/.claude/skills` に同期）。
- メカニズム: `scripts/ask-human.sh`（Slack `chat.postMessage` + `reactions.get` + `conversations.replies`）。

## トリガー条件（8 カテゴリ）

1. 破壊的 DB 操作（DROP/ALTER TYPE/TRUNCATE/WHERE 無し DELETE 等）
2. 本番デプロイ・リリース判断
3. 要配慮個人情報・診療データの外部送信/マスキング判断
4. 課金・支払い・コスト発生
5. 認証・認可・セキュリティ設定変更
6. 不可逆・広範囲な一括変更
7. 医療法・薬機法・獣医療法に関わる判断
8. 仕様が曖昧で AI が推測になる分岐

## 運用ガイド

```bash
result="$(bash scripts/ask-human.sh '質問文（A=… / B=…）')"
# 出力: A | B | REPLY: <text> | ABORT: <理由>
```

| 出力 | 意味 | 取るべき行動 |
|------|------|------------|
| `A` | 👍/✅ リアクション | 承認/はい として進む |
| `B` | 👎/❌ リアクション | 却下/いいえ。実行しない |
| `REPLY: ...` | スレッド返信 | 返信内容の指示に従う |
| `ABORT: ...` | タイムアウト(30分)/送信不可 | **中断**（実行しない） |

環境変数: `SLACK_BOT_TOKEN`（必須）/ `SLACK_MENTION_USER_ID`（既定 U0AMRAQDW65）/
`ASK_HUMAN_TIMEOUT_SEC`（既定 1800）/ `ASK_HUMAN_POLL_SEC`（既定 10）。

## VM テスト

```bash
gcloud compute ssh spm-dev-agent-vm --zone=asia-northeast1-b --quiet \
  --command='ASK_HUMAN_TIMEOUT_SEC=120 bash ~/spm-dev-agent-cloud/scripts/ask-human.sh "HITLテスト: 👍か👎で反応してください"'
```
Slack DM が届き、リアクション/返信で結果が stdout に返ることを確認する。
