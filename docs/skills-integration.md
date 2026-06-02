# スキル統合 — spm-medical-pack を Claude Code から参照する

spm-dev-agent が VM 上で spawn する Claude Code に、`spm-medical-pack` の SKILL.md
（約230件）を参照させるための設定。

> **全リソース（agents/skills/commands/legacy/hooks）の統合**は
> `scripts/sync-claude-resources.sh` を使う（skills のみは旧 `scripts/sync-skills.sh`）。
> リソース一覧・件数・役割は [medical-pack-inventory.md](medical-pack-inventory.md) を参照。
> 本書は skills を中心とした検出方式の解説。

## 仕組み（重要）

Claude Code のスキル検出は **`$HOME/.claude/skills/<name>/SKILL.md`** と
プラグイン（`$HOME/.claude/plugins/`）に限られる。

- **`CLAUDE_SKILLS_DIR` 環境変数・`--skill-dir` フラグは存在しない**（指定しても無効）。
- spm-dev-agent の spawn（`src/lib/claude-code-runner.ts`）は
  - 作業ディレクトリ = 対象リポ（`SPM_PROJECTS_ROOT/<repo>`）
  - `HOME = /home/ishiitakeshi`（Linux VM、`defaultHome()`）
  で `claude --dangerously-skip-permissions` を起動する。
- 作業ディレクトリは対象リポなのでプロジェクトローカルの `.claude/skills` は使えない。
  **唯一 cwd 非依存で確実なのはユーザーグローバルの `/home/ishiitakeshi/.claude/skills/`** に
  スキルを置くこと。

## スキルディレクトリの場所

| 種別 | パス |
|------|------|
| medical-pack クローン | `/home/ishiitakeshi/spm-medical-pack`（`skills/<name>/SKILL.md`） |
| Claude Code 参照先 | `/home/ishiitakeshi/.claude/skills/<name>/`（各スキルへの symlink） |
| spawn 時 HOME | `/home/ishiitakeshi`（`claude-code-runner.ts: defaultHome()`） |

## VM 上での同期方法

`scripts/sync-skills.sh` が clone/pull → 各スキルを `~/.claude/skills/` へ symlink する（冪等）。

```bash
# VM (spm-dev-agent-vm) 上で実行
cd /home/ishiitakeshi/spm-dev-agent-cloud
git pull --ff-only                 # 本リポ更新
bash scripts/sync-skills.sh        # medical-pack を取得し ~/.claude/skills へ反映
# 出力例: [SKILLS] Loaded: 236 skills from /home/ishiitakeshi/spm-medical-pack/skills ...
```

ローカル(Mac)から実行する場合:

```bash
gcloud compute ssh spm-dev-agent-vm --zone=asia-northeast1-b \
  --command='cd ~/spm-dev-agent-cloud && bash scripts/sync-skills.sh'
```

> private リポで VM に git 認証が無い場合は、Mac から
> `gcloud compute scp --recurse ~/workspace/spm-medical-pack/skills spm-dev-agent-vm:~/spm-medical-pack/ --zone=asia-northeast1-b`
> で転送してから `MEDICAL_PACK_DIR=~/spm-medical-pack bash scripts/sync-skills.sh` を実行する。

## スキルの追加方法

1. `spm-medical-pack` リポにスキルを追加（`skills/<new-skill>/SKILL.md`）して PR → merge。
2. VM で `bash scripts/sync-skills.sh` を再実行（git pull + symlink 更新）。
3. 次回以降に spawn される Claude Code が新スキルを検出する。

## systemd（任意）

`CLAUDE_SKILLS_DIR` は不要（存在しないため）。代わりに worker 起動前に同期したい場合は
`spm-dev-agent-worker.service` に `ExecStartPre` を追加する:

```ini
[Service]
ExecStartPre=/usr/bin/bash /home/ishiitakeshi/spm-dev-agent-cloud/scripts/sync-skills.sh
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart spm-dev-agent-worker
```

## SPM 固有スキル（必ず参照させたいもの）

| スキル | 用途 |
|--------|------|
| `spm-sensitive-personal-info` | 要配慮個人情報・マスキング |
| `spm-3sho-2gl-check` | 3省2ガイドライン |
| `spm-mrna-gmp` | mRNA GMP |
| `spm-veterinary-care-act` | 獣医療法 |
| `spm-electronic-record-3principles` | 電子保存3原則 |
| `spm-medical-bcp` | 医療BCP |
| `spm-samd-classification` | SaMD（プログラム医療機器）分類 |
| `peco-ui` | PECO UI デザイントークン |
| `healthcare-cdss-patterns` / `healthcare-emr-patterns` | CDSS / EMR |
| `healthcare-phi-compliance` / `hipaa-compliance` | PHI（米国基準。日本は要配慮個人情報と読替） |
| `healthcare-eval-harness` | 医療 eval |
| `safety-guard` / `security-review` / `security-scan` | 安全・セキュリティ |
