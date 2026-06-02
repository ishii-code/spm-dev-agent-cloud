#!/usr/bin/env bash
#
# ask-human.sh — 重要判断を AI に任せず人間に Slack DM で問い合わせる HITL ヘルパー。
#
# 使い方:
#   scripts/ask-human.sh "本番DBに DROP COLUMN を実行してよいですか？"
#
# 出力(stdout、Claude Code がパースする):
#   A            … 👍/✅ リアクション = 承認/はい
#   B            … 👎/❌ リアクション = 却下/いいえ
#   REPLY: <text>… スレッド返信の本文（自由記述の指示）
#   ABORT: <理由>… タイムアウト / 送信不可（デフォルト中断）
#
# 環境変数:
#   SLACK_BOT_TOKEN        (必須。VM systemd unit に設定済み)
#   SLACK_MENTION_USER_ID  (既定 U0AMRAQDW65)
#   ASK_HUMAN_TIMEOUT_SEC  (既定 1800 = 30分)
#   ASK_HUMAN_POLL_SEC     (既定 10)
set -euo pipefail

TOKEN="${SLACK_BOT_TOKEN:-}"
export ASK_USER_ID="${SLACK_MENTION_USER_ID:-U0AMRAQDW65}"
export ASK_QUESTION="${1:-確認が必要です}"
TIMEOUT="${ASK_HUMAN_TIMEOUT_SEC:-1800}"
POLL="${ASK_HUMAN_POLL_SEC:-10}"

[ -n "$TOKEN" ] || { echo "ABORT: SLACK_BOT_TOKEN 未設定"; exit 0; }

post() { curl -sS -H "Authorization: Bearer $TOKEN" -H 'Content-type: application/json; charset=utf-8' "$@"; }
getq() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# 1) DM チャンネルを open（User ID から D... を得る）
channel="$(post -d "{\"users\":\"$ASK_USER_ID\"}" https://slack.com/api/conversations.open \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("channel",{}).get("id","") if d.get("ok") else "")')"
[ -n "$channel" ] || { echo "ABORT: DM open 失敗"; exit 0; }
export ASK_CHANNEL="$channel"

# 2) メンション付きで質問を送信
body="$(python3 -c 'import os,json
text="<@%s> 🤔 *確認が必要です（HITL）*\n%s\n\n👍/✅ = A（承認/はい）   👎/❌ = B（却下/いいえ）   または このメッセージに返信で詳細指示" % (os.environ["ASK_USER_ID"], os.environ["ASK_QUESTION"])
print(json.dumps({"channel":os.environ["ASK_CHANNEL"],"text":text}))')"
ts="$(post -d "$body" https://slack.com/api/chat.postMessage \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ts","") if d.get("ok") else "")')"
[ -n "$ts" ] || { echo "ABORT: メッセージ送信失敗"; exit 0; }

# 3) リアクション or スレッド返信を待つ（30分）
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  decision="$(getq "https://slack.com/api/reactions.get?channel=${channel}&timestamp=${ts}" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
n=set(x["name"] for x in d.get("message",{}).get("reactions",[])) if d.get("ok") else set()
A={"white_check_mark","heavy_check_mark","+1","thumbsup"}; B={"x","no_entry_sign","-1","thumbsdown"}
print("A" if n&A else ("B" if n&B else ""))')"
  [ -n "$decision" ] && { echo "$decision"; exit 0; }

  reply="$(getq "https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
ms=d.get("messages",[]) if d.get("ok") else []
for m in ms[1:]:
    if "bot_id" not in m and m.get("text","").strip():
        print(m["text"].strip()); break')"
  [ -n "$reply" ] && { echo "REPLY: $reply"; exit 0; }

  sleep "$POLL"
done
echo "ABORT: タイムアウト(${TIMEOUT}s) — デフォルト中断"
exit 0
