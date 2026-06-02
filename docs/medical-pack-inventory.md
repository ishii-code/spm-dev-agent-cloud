# spm-medical-pack リソースインベントリ

spm-dev-agent の Claude Code（Mac 開発機 / VM `spm-dev-agent-vm`）が参照する
`spm-medical-pack` の全リソース一覧。同期は `scripts/sync-claude-resources.sh`。

## リソース一覧

| 種別 | ソース | 統合先 (`~/.claude/`) | 件数(目安) | 役割 |
|------|--------|----------------------|-----------|------|
| Agents | `spm-medical-pack/agents/*.md` | `~/.claude/agents/` | 60 | サブエージェント（言語別レビュアー・ビルド解決・医療系など） |
| Skills | `spm-medical-pack/skills/*/SKILL.md` + `.agents/skills/*/` | `~/.claude/skills/` | 約237 | SKILL.md 群（SPM 固有 + 汎用） |
| Commands | `spm-medical-pack/.claude/commands/*.md` + `commands/*.md` | `~/.claude/commands/` | 約81 | スラッシュコマンド |
| Legacy Shims | `spm-medical-pack/legacy-command-shims/commands/*` | `~/.claude/commands/legacy/` | 12 | 旧コマンド互換シム |
| Hooks | `spm-medical-pack/hooks/*` + `scripts/hooks/*` | `~/.claude/hooks/` | 約50 | フックスクリプト・設定（`hooks.json` 等） |

> 同期は **symlink**（冪等）。既存の実体ファイル/ディレクトリは上書きしない（`[ -e ] || ln -s`）。

## 検出の仕組み（重要）

- Claude Code は `$HOME/.claude/{agents,skills,commands}/` を自動検出する。
- spawn される `claude`（`src/lib/claude-code-runner.ts`）は **HOME=`/home/ishiitakeshi`（VM）/ `/Users/ishiitakeshi`（Mac）**、cwd=対象リポ。
  そのため cwd 非依存で確実なのは `$HOME/.claude/` への配置のみ。
- **`CLAUDE_SKILLS_DIR` 環境変数・`--skill-dir` フラグは存在しない**（指定しても無効）。
- **Hooks** は `~/.claude/hooks/` に置くだけでは自動起動しない。`settings.json` の hooks 設定で
  明示的に有効化する必要がある（本同期は参照可能化のみ。有効化はスコープ外）。

## SPM 固有スキル（必ず参照させたいもの）

`spm-sensitive-personal-info` / `spm-3sho-2gl-check` / `spm-mrna-gmp` /
`spm-veterinary-care-act` / `spm-electronic-record-3principles` / `spm-medical-bcp` /
`spm-samd-classification` / `peco-ui` / `healthcare-cdss-patterns` /
`healthcare-emr-patterns` / `healthcare-phi-compliance` / `healthcare-eval-harness` /
`hipaa-compliance` / `safety-guard` / `security-review` / `security-scan`

## 同期コマンド

```bash
# Mac
cd ~/workspace/spm-dev-agent-cloud && bash scripts/sync-claude-resources.sh

# VM
gcloud compute ssh spm-dev-agent-vm --zone=asia-northeast1-b --quiet \
  --command='cd ~/spm-dev-agent-cloud && git pull --ff-only && bash scripts/sync-claude-resources.sh'
```

詳細は [skills-integration.md](skills-integration.md)。
