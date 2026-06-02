#!/usr/bin/env bash
#
# sync-claude-resources.sh — spm-medical-pack の全 Claude Code リソース
# (agents / skills / commands / legacy shims / hooks) を $HOME/.claude/ へ symlink する。
# 冪等。Mac/VM 両対応。Claude Code は $HOME/.claude/{agents,skills,commands} を検出する
# （CLAUDE_SKILLS_DIR/--skill-dir は存在しない）。
#
# 使い方:
#   bash scripts/sync-claude-resources.sh
# 環境変数:
#   SRC  (既定: $HOME/workspace/spm-medical-pack)  ※VM では $HOME/spm-medical-pack
#   DEST (既定: $HOME/.claude)
set -euo pipefail

# SRC 自動解決: 指定が無く workspace 版が無ければ $HOME/spm-medical-pack(VM) を使う。
if [ -z "${SRC:-}" ]; then
  if [ -d "$HOME/workspace/spm-medical-pack" ]; then
    SRC="$HOME/workspace/spm-medical-pack"
  else
    SRC="$HOME/spm-medical-pack"
  fi
fi
DEST="${DEST:-$HOME/.claude}"
echo "[CLAUDE RESOURCES] SRC=$SRC DEST=$DEST"

# 1. Agents
mkdir -p "$DEST/agents"
for file in "$SRC/agents/"*.md; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  [ -e "$DEST/agents/$name" ] || ln -s "$file" "$DEST/agents/$name"
done
agents_count=$(find "$DEST/agents" -maxdepth 1 -name "*.md" | wc -l | tr -d ' ')

# 2. Skills (skills/ と .agents/skills/)
mkdir -p "$DEST/skills"
for dir in "$SRC/skills/"*/ "$SRC/.agents/skills/"*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  [ -e "$DEST/skills/$name" ] || ln -s "${dir%/}" "$DEST/skills/$name"
done
skills_count=$(find "$DEST/skills" -maxdepth 1 -type l | wc -l | tr -d ' ')

# 3. Slash Commands (.claude/commands + commands)
mkdir -p "$DEST/commands"
for src_dir in "$SRC/.claude/commands" "$SRC/commands"; do
  if [ -d "$src_dir" ]; then
    for file in "$src_dir"/*.md; do
      [ -f "$file" ] || continue
      name=$(basename "$file")
      [ -e "$DEST/commands/$name" ] || ln -s "$file" "$DEST/commands/$name"
    done
  fi
done
commands_count=$(find "$DEST/commands" -maxdepth 1 -name "*.md" | wc -l | tr -d ' ')

# 4. Legacy Command Shims
mkdir -p "$DEST/commands/legacy"
if [ -d "$SRC/legacy-command-shims/commands" ]; then
  for file in "$SRC/legacy-command-shims/commands"/*.md "$SRC/legacy-command-shims/commands"/*.sh; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    [ -e "$DEST/commands/legacy/$name" ] || ln -s "$file" "$DEST/commands/legacy/$name"
  done
fi
legacy_count=$(find "$DEST/commands/legacy" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')

# 5. Hooks (hooks/ と scripts/hooks/)
mkdir -p "$DEST/hooks"
for src_dir in "$SRC/hooks" "$SRC/scripts/hooks"; do
  if [ -d "$src_dir" ]; then
    for item in "$src_dir"/*; do
      [ -e "$item" ] || continue
      name=$(basename "$item")
      [ -e "$DEST/hooks/$name" ] || ln -s "$item" "$DEST/hooks/$name"
    done
  fi
done
hooks_count=$(find "$DEST/hooks" -maxdepth 1 ! -path "$DEST/hooks" | wc -l | tr -d ' ')

echo "===================="
echo "[CLAUDE RESOURCES] Sync complete:"
echo "  Agents:   $agents_count"
echo "  Skills:   $skills_count"
echo "  Commands: $commands_count"
echo "  Legacy:   $legacy_count"
echo "  Hooks:    $hooks_count"
echo "===================="
