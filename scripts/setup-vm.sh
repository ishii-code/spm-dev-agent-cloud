#!/usr/bin/env bash
#
# setup-vm.sh — GCE VM (i-β) 上で claude-worker をゼロから常駐させるワンショット
# セットアップ（冪等）。既存リソースは上書きせず skip / 更新する。
#
# 前提:
#   - VM に node / npm が導入済み（tsx は repo の devDeps に同梱＝npm ci で入る）。
#   - 本 repo が既に clone 済みで、その中からこのスクリプトを実行する。
#       例) sudo mkdir -p /opt/spm-dev-agent && sudo chown takeshi_ishii:takeshi_ishii /opt/spm-dev-agent
#           git clone git@github.com:ishii-code/spm-dev-agent-cloud.git /opt/spm-dev-agent
#           cd /opt/spm-dev-agent && sudo -E SQL_INSTANCE=... bash scripts/setup-vm.sh
#   - 実行ユーザ（サービスの User/Group）は takeshi_ishii。
#
# 必須環境変数:
#   SQL_INSTANCE   Cloud SQL インスタンス接続名 PROJECT:REGION:INSTANCE
#                  取得: gcloud sql instances list --project vets-biz-aigen-apps
#
# worker.env に要る env キー（このスクリプトは値を直書きせず、実行時の環境変数を
# 引き継ぐか、無ければプレースホルダを書く。シークレットは後で手で埋める）:
#   必須        : DATABASE_URL, ANTHROPIC_API_KEY
#   通知        : SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APPROVAL_CHANNEL
#   VM 特有     : SPM_PROJECTS_ROOT, CLAUDE_BIN
#   認証/其他   : AUTH_SECRET, SERVICE_API_KEY, OPENAI_API_KEY
#   ※ SPM_EXEC_HOST は worker がコードで自動設定するため worker.env に書かない。
#
# 使い方:
#   sudo -E SQL_INSTANCE=vets-biz-aigen-apps:asia-northeast1:<INSTANCE> bash scripts/setup-vm.sh
#   （-E で呼び出し側の env を sudo に引き継ぐ＝DATABASE_URL 等を baked したい場合）
#
set -euo pipefail

# ---- 設定（環境変数で上書き可）---------------------------------------------
RUN_USER="${RUN_USER:-takeshi_ishii}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_DIR="/etc/spm-dev-agent"
ENV_FILE="${ENV_DIR}/worker.env"
PROXY_BIN="/usr/local/bin/cloud-sql-proxy"
PROXY_VERSION="${PROXY_VERSION:-v2.14.0}"
PROXY_PORT="${PROXY_PORT:-5432}"
HEALTH_PORT="${HEALTH_PORT:-3001}"
WORKER_UNIT="/etc/systemd/system/spm-dev-agent-worker.service"
PROXY_UNIT="/etc/systemd/system/cloud-sql-proxy.service"

log()  { printf '\033[1;36m[setup-vm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-vm][warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup-vm][error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 事前チェック -----------------------------------------------------------
[[ $EUID -eq 0 ]] || die "root で実行してください（sudo bash scripts/setup-vm.sh）。"
[[ -n "${SQL_INSTANCE:-}" ]] || die "SQL_INSTANCE が未設定です。gcloud sql instances list で取得し SQL_INSTANCE=PROJECT:REGION:INSTANCE を渡してください。"
id "$RUN_USER" >/dev/null 2>&1 || die "実行ユーザ $RUN_USER が存在しません。"
command -v npm >/dev/null 2>&1 || die "npm が見つかりません（node/npm を先に導入）。"
[[ -f "${REPO_DIR}/package.json" ]] || die "REPO_DIR=${REPO_DIR} に package.json がありません（repo 内から実行してください）。"
log "REPO_DIR=${REPO_DIR} / RUN_USER=${RUN_USER} / SQL_INSTANCE=${SQL_INSTANCE}"

# ---- 1) cloud-sql-proxy v2 インストール（冪等）------------------------------
if [[ -x "$PROXY_BIN" ]]; then
  log "cloud-sql-proxy は既に存在: $($PROXY_BIN --version 2>/dev/null | head -1 || echo '(version 不明)') → skip"
else
  log "cloud-sql-proxy ${PROXY_VERSION} を取得..."
  arch="$(uname -m)"; case "$arch" in x86_64) gobin="amd64";; aarch64|arm64) gobin="arm64";; *) die "未対応 arch: $arch";; esac
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${PROXY_VERSION}/cloud-sql-proxy.linux.${gobin}" \
    || die "cloud-sql-proxy のダウンロードに失敗（PROXY_VERSION=${PROXY_VERSION} を確認）。"
  install -m 0755 "$tmp" "$PROXY_BIN"; rm -f "$tmp"
  log "installed: $($PROXY_BIN --version 2>/dev/null | head -1 || true)"
fi

# ---- 2) cloud-sql-proxy systemd 化（冪等・unit は常に最新化）----------------
log "write ${PROXY_UNIT}"
cat > "$PROXY_UNIT" <<EOF
[Unit]
Description=Cloud SQL Auth Proxy (spm-dev-agent)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${PROXY_BIN} --address 127.0.0.1 --port ${PROXY_PORT} ${SQL_INSTANCE}
Restart=on-failure
RestartSec=5
User=${RUN_USER}
Group=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

# ---- 3) worker.env 生成（既存は非上書き＝シークレット保護）-------------------
mkdir -p "$ENV_DIR"
if [[ -f "$ENV_FILE" ]]; then
  warn "${ENV_FILE} は既に存在 → 上書きしません（既存のシークレットを保護）。"
else
  log "write ${ENV_FILE}（値は環境変数を引き継ぎ、無ければプレースホルダ）"
  cat > "$ENV_FILE" <<EOF
# spm-dev-agent worker 環境変数。プレースホルダは実値に置換すること。
# 必須（無いと worker は起動直後に exit する）
DATABASE_URL=${DATABASE_URL:-postgresql://USER:PASSWORD@127.0.0.1:${PROXY_PORT}/spm_dev_agent?schema=public}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-REPLACE_ME}
# 承認 / HITL 通知（無いと Slack 通知が発火しない）
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-REPLACE_ME}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET:-REPLACE_ME}
SLACK_APPROVAL_CHANNEL=${SLACK_APPROVAL_CHANNEL:-C0B3D1S0LER}
# VM 特有（spawn 対象リポ親 / claude バイナリ。未指定は PATH 解決）
SPM_PROJECTS_ROOT=${SPM_PROJECTS_ROOT:-/home/${RUN_USER}/spm-projects}
CLAUDE_BIN=${CLAUDE_BIN:-}
# 認証 / オーケストレーション
AUTH_SECRET=${AUTH_SECRET:-REPLACE_ME}
SERVICE_API_KEY=${SERVICE_API_KEY:-REPLACE_ME}
OPENAI_API_KEY=${OPENAI_API_KEY:-REPLACE_ME}
EOF
fi
chown "$RUN_USER:$RUN_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---- 4) 依存インストール + Prisma クライアント生成（RUN_USER 権限で）---------
log "npm ci（${REPO_DIR}）"
sudo -u "$RUN_USER" bash -lc "cd '${REPO_DIR}' && npm ci"
log "prisma generate"
sudo -u "$RUN_USER" bash -lc "cd '${REPO_DIR}' && npx prisma generate"

# ---- 5) worker systemd unit（User=Group=RUN_USER）---------------------------
log "write ${WORKER_UNIT}"
cat > "$WORKER_UNIT" <<EOF
[Unit]
Description=SPM dev-agent Claude worker
After=network-online.target cloud-sql-proxy.service
Wants=network-online.target
Requires=cloud-sql-proxy.service

[Service]
Type=notify
NotifyAccess=all
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npm run worker
Restart=on-failure
RestartSec=5
WatchdogSec=60
Environment=NODE_ENV=production
Environment=HEALTH_PORT=${HEALTH_PORT}
EnvironmentFile=${ENV_FILE}
User=${RUN_USER}
Group=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

# ---- 6) proxy を先に起動 → DB 到達後に migrate deploy ----------------------
log "daemon-reload + cloud-sql-proxy 起動"
systemctl daemon-reload
systemctl enable --now cloud-sql-proxy

log "Cloud SQL Proxy の待受確認（127.0.0.1:${PROXY_PORT}）"
for i in $(seq 1 30); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PROXY_PORT}") 2>/dev/null; then exec 3>&- 3<&-; log "proxy ready"; break; fi
  [[ $i -eq 30 ]] && die "cloud-sql-proxy が ${PROXY_PORT} で待受しません。journalctl -u cloud-sql-proxy を確認。"
  sleep 1
done

log "prisma migrate deploy（worker.env の DATABASE_URL を使用）"
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
sudo -u "$RUN_USER" env DATABASE_URL="${DATABASE_URL}" bash -lc "cd '${REPO_DIR}' && npx prisma migrate deploy" \
  || warn "migrate deploy 失敗。DATABASE_URL（${ENV_FILE}）と proxy 接続を確認のうえ手動で再実行してください。"

# ---- 7) worker 起動 + 稼働確認 ----------------------------------------------
log "spm-dev-agent-worker を enable --now"
systemctl enable --now spm-dev-agent-worker

sleep 3
log "=== 稼働確認 ==="
systemctl --no-pager --full status cloud-sql-proxy        | sed -n '1,4p' || true
systemctl --no-pager --full status spm-dev-agent-worker   | sed -n '1,6p' || true
log "worker 直近ログ:"; journalctl -u spm-dev-agent-worker -n 15 --no-pager || true
log "health:"; curl -fsS "localhost:${HEALTH_PORT}/health" && echo || warn "health 取得失敗（起動直後の可能性。journalctl -u spm-dev-agent-worker -f で追尾）。"

log "完了。期待ログ: '[WORKER] SPM_EXEC_HOST set; isExecHost()=true' と 5秒毎の '[TICK] start/end'。"
log "未設定のシークレットがある場合: ${ENV_FILE} を編集 → sudo systemctl restart spm-dev-agent-worker"
