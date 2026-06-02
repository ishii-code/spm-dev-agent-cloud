#!/usr/bin/env bash
#
# vm-logs.sh — claude-worker / spm-dev-agent-web の systemd ログ簡易閲覧ラッパー。
# VM (i-β) 上で systemctl / journalctl を直接叩くより短いコマンドで状況を確認する。
#
# 使い方:
#   scripts/vm-logs.sh status            # 両サービスの稼働状態
#   scripts/vm-logs.sh tail [svc]        # ログを追尾 (-f)。svc 省略時は worker
#   scripts/vm-logs.sh errors [svc] [N]  # 直近 N 分の ERROR/WARN/spawn失敗を抽出 (既定 60 分)
#   scripts/vm-logs.sh health            # /health エンドポイントを curl
#
# 環境変数:
#   WORKER_UNIT  (既定: spm-dev-agent-worker)
#   WEB_UNIT     (既定: spm-dev-agent-web)
#   HEALTH_PORT  (既定: 3001)  worker の /health ポート
set -euo pipefail

WORKER_UNIT="${WORKER_UNIT:-spm-dev-agent-worker}"
WEB_UNIT="${WEB_UNIT:-spm-dev-agent-web}"
HEALTH_PORT="${HEALTH_PORT:-3001}"

resolve_unit() {
  case "${1:-worker}" in
    worker|w|"") echo "$WORKER_UNIT" ;;
    web|server|s) echo "$WEB_UNIT" ;;
    *) echo "$1" ;;  # フルユニット名を直接渡したケース
  esac
}

cmd="${1:-status}"
shift || true

case "$cmd" in
  status)
    for u in "$WORKER_UNIT" "$WEB_UNIT"; do
      echo "=== $u ==="
      systemctl status "$u" --no-pager --lines=0 || true
      echo
    done
    ;;

  tail|follow|-f)
    unit="$(resolve_unit "${1:-worker}")"
    echo "[vm-logs] tailing $unit (Ctrl-C で終了)"
    journalctl -u "$unit" -f --output=short-iso
    ;;

  errors|err)
    unit="$(resolve_unit "${1:-worker}")"
    mins="${2:-60}"
    echo "[vm-logs] $unit の直近 ${mins} 分の ERROR / WARN / spawn失敗 / OpenAI呼出失敗:"
    # -p err..warning では拾えないアプリ独自プレフィックスも grep で補足する。
    journalctl -u "$unit" --since "-${mins}min" --output=short-iso --no-pager \
      | grep -iE "\[ERROR\]|\[WARN\]|error|warning|spawn.*fail|failed to spawn|\[ORCHESTRATOR\].*(失敗|fail)|OpenAI.*(失敗|fail)" \
      || echo "  (該当ログなし)"
    ;;

  health)
    echo "[vm-logs] worker /health:"
    curl -fsS --max-time 3 "http://localhost:${HEALTH_PORT}/health" && echo \
      || echo "  worker /health に到達できません (ポート ${HEALTH_PORT})"
    ;;

  *)
    echo "usage: $0 {status|tail [svc]|errors [svc] [minutes]|health}" >&2
    echo "  svc = worker | web | <unit-name>" >&2
    exit 2
    ;;
esac
