#!/usr/bin/env bash
#
# sync-skills.sh — spm-medical-pack のスキル(SKILL.md)を VM 上の Claude Code に参照させる。
#
# 重要（Claude Code のスキル検出方式）:
#   Claude Code は $HOME/.claude/skills/<name>/SKILL.md と
#   プラグイン($HOME/.claude/plugins/)からスキルを検出する。
#   CLAUDE_SKILLS_DIR 環境変数 / --skill-dir フラグは存在しない（指定しても無効）。
#   spm-dev-agent が spawn する claude は HOME=/home/ishiitakeshi で起動し、
#   作業ディレクトリは対象リポ（SPM_PROJECTS_ROOT/<repo>）になる。よってプロジェクト
#   ローカルの .claude/skills は使えず、ユーザーグローバルの $HOME/.claude/skills へ
#   スキルを配置するのが唯一 cwd 非依存で確実な方法。本スクリプトは各スキルを
#   $HOME/.claude/skills へ symlink する（冪等）。
#
# 使い方（VM 上）:
#   bash scripts/sync-skills.sh            # clone/pull して symlink 更新
#
# 環境変数:
#   MEDICAL_PACK_REPO  (既定: https://github.com/ishii-code/spm-medical-pack.git)
#   MEDICAL_PACK_DIR   (既定: $HOME/spm-medical-pack)
#   CLAUDE_SKILLS_DEST (既定: $HOME/.claude/skills)
set -euo pipefail

REPO_URL="${MEDICAL_PACK_REPO:-https://github.com/ishii-code/spm-medical-pack.git}"
PACK_DIR="${MEDICAL_PACK_DIR:-$HOME/spm-medical-pack}"
SKILLS_SRC="${PACK_DIR}/skills"
DEST="${CLAUDE_SKILLS_DEST:-$HOME/.claude/skills}"

# 1) リポ取得・更新
if [ -d "${PACK_DIR}/.git" ]; then
  echo "[SKILLS] git pull ${PACK_DIR}"
  git -C "${PACK_DIR}" pull --ff-only || echo "[SKILLS] WARN: git pull 失敗（既存内容で継続）"
else
  echo "[SKILLS] git clone ${REPO_URL} -> ${PACK_DIR}"
  git clone --depth 1 "${REPO_URL}" "${PACK_DIR}"
fi

if [ ! -d "${SKILLS_SRC}" ]; then
  echo "[SKILLS] ERROR: スキルディレクトリが見つかりません: ${SKILLS_SRC}" >&2
  exit 1
fi

mkdir -p "${DEST}"

# 2) 各スキルを symlink（冪等。既存の実体ディレクトリ＝非symlink は保護してスキップ）
linked=0
skipped=0
for d in "${SKILLS_SRC}"/*/; do
  [ -f "${d}SKILL.md" ] || continue
  name="$(basename "$d")"
  target="${DEST}/${name}"
  if [ -L "${target}" ]; then
    ln -sfn "${d%/}" "${target}"
    linked=$((linked + 1))
  elif [ -e "${target}" ]; then
    echo "[SKILLS] skip (既存・非symlink): ${name}"
    skipped=$((skipped + 1))
  else
    ln -s "${d%/}" "${target}"
    linked=$((linked + 1))
  fi
done

# symlink 先を辿るため -L を付ける（付けないと symlink 配下の SKILL.md を数えられない）。
visible="$(find -L "${DEST}" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
echo "[SKILLS] Loaded: ${linked} skills from ${SKILLS_SRC} (skipped ${skipped}); ${DEST} に SKILL.md ${visible} 件が参照可能"
