#!/usr/bin/env bash
#
# setup-monitoring.sh — Cloud Logging ログベースメトリック + Cloud Monitoring
# アラートポリシーをまとめて作成する（冪等。既存なら skip）。
#
# 監視対象:
#   1. spm-dev-agent-web (Cloud Run) の ERROR ログ数 … 5 分平均 > 5 件でアラート
#   2. claude-worker (VM) の spawn 失敗 / [ORCHESTRATOR] OpenAI 呼出失敗 … 検出でアラート
#   超過時は Slack (#monitoring) へ通知する。
#
# 前提:
#   - gcloud CLI 認証済み（gcloud auth login / SA）
#   - alpha コンポーネント: gcloud components install alpha
#
# 使い方:
#   PROJECT_ID=vets-biz-aigen-apps \
#   NOTIFICATION_CHANNEL=projects/.../notificationChannels/123 \
#     scripts/setup-monitoring.sh
#
#   NOTIFICATION_CHANNEL 未指定の場合は Slack チャンネルの作成手順を表示して終了する
#   （Slack 通知チャンネルは初回のみ OAuth が必要なため Console もしくは下記コマンドで作成）。
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-vets-biz-aigen-apps}"
WEB_SERVICE="${WEB_SERVICE:-spm-dev-agent-web}"

METRIC_WEB_ERRORS="spm_web_error_count"
METRIC_WORKER_FAILS="claude_worker_failure_count"

echo "[setup-monitoring] project=${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# ---- 1. ログベースメトリック ----------------------------------------------

create_metric() {
  local name="$1" desc="$2" filter="$3"
  if gcloud logging metrics describe "${name}" >/dev/null 2>&1; then
    echo "[metric] ${name} は既存 → フィルタ更新"
    gcloud logging metrics update "${name}" --log-filter="${filter}" --quiet
  else
    echo "[metric] ${name} を新規作成"
    gcloud logging metrics create "${name}" \
      --description="${desc}" \
      --log-filter="${filter}" --quiet
  fi
}

create_metric "${METRIC_WEB_ERRORS}" \
  "spm-dev-agent-web Cloud Run の ERROR 以上のログ件数" \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${WEB_SERVICE}\" AND severity>=ERROR"

# worker は GCE VM 上で稼働。textPayload / jsonPayload.message の両方を拾う。
create_metric "${METRIC_WORKER_FAILS}" \
  "claude-worker の spawn 失敗 / ORCHESTRATOR OpenAI 呼出失敗の件数" \
  '(resource.type="gce_instance" OR resource.type="generic_node" OR resource.type="generic_task") AND (textPayload=~"spawn.*fail|failed to spawn|\[ORCHESTRATOR\].*(失敗|fail)|OpenAI.*(失敗|fail)" OR jsonPayload.message=~"spawn.*fail|failed to spawn|\[ORCHESTRATOR\].*(失敗|fail)|OpenAI.*(失敗|fail)")'

# ---- 2. 通知チャンネル -----------------------------------------------------

if [[ -z "${NOTIFICATION_CHANNEL:-}" ]]; then
  cat <<'EOS'

[notice] NOTIFICATION_CHANNEL が未指定のためアラートポリシー作成をスキップしました。
Slack 通知チャンネルを作成してから再実行してください。

  # 既存チャンネル一覧:
  gcloud beta monitoring channels list --format='table(displayName,type,name)'

  # Slack チャンネルを作成（初回は Slack OAuth 連携が必要。Console 推奨）:
  #   Cloud Console → Monitoring → Alerting → Edit notification channels → Slack → #monitoring を接続
  # 作成後、その name を NOTIFICATION_CHANNEL に渡して再実行:
  #   NOTIFICATION_CHANNEL=projects/PROJECT/notificationChannels/XXXX scripts/setup-monitoring.sh
EOS
  exit 0
fi

# ---- 3. アラートポリシー ---------------------------------------------------

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

create_policy_from_file() {
  local display="$1" file="$2"
  # 同名ポリシーが既にあれば skip（重複作成防止）。
  if gcloud alpha monitoring policies list \
        --filter="displayName=\"${display}\"" \
        --format='value(name)' | grep -q .; then
    echo "[policy] ${display} は既存 → skip"
    return
  fi
  echo "[policy] ${display} を作成"
  gcloud alpha monitoring policies create --policy-from-file="${file}" --quiet
}

# 3-1. Web ERROR 数 5 分平均 > 5
cat > "${TMPDIR}/web-errors.json" <<EOF
{
  "displayName": "spm-dev-agent-web ERROR 多発 (5分平均>5)",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "web ERROR count > 5 (5m)",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/${METRIC_WEB_ERRORS}\" AND resource.type=\"cloud_run_revision\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 5,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_MEAN",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ]
      }
    }
  ],
  "notificationChannels": ["${NOTIFICATION_CHANNEL}"],
  "documentation": {
    "content": "spm-dev-agent-web の ERROR ログが 5 分平均で 5 件を超過。docs/runbook.md の障害対応を参照。",
    "mimeType": "text/markdown"
  }
}
EOF
create_policy_from_file "spm-dev-agent-web ERROR 多発 (5分平均>5)" "${TMPDIR}/web-errors.json"

# 3-2. worker spawn / OpenAI 呼出失敗の検出
cat > "${TMPDIR}/worker-fails.json" <<EOF
{
  "displayName": "claude-worker spawn/OpenAI 失敗検出",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "worker failure detected (5m)",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/${METRIC_WORKER_FAILS}\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_SUM",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ]
      }
    }
  ],
  "notificationChannels": ["${NOTIFICATION_CHANNEL}"],
  "documentation": {
    "content": "claude-worker で spawn 失敗または [ORCHESTRATOR] OpenAI 呼出失敗を検出。docs/runbook.md の Worker 停止時対応を参照。",
    "mimeType": "text/markdown"
  }
}
EOF
create_policy_from_file "claude-worker spawn/OpenAI 失敗検出" "${TMPDIR}/worker-fails.json"

echo "[setup-monitoring] 完了。Console → Monitoring → Alerting で確認してください。"
