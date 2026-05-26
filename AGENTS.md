<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# spm-dev-agent — 開発エージェント

## システム位置づけ

SPM 5層アーキテクチャの**外側**にあるメタツール。自身は医療データを扱わないが、**生成するコードが他の SPM システム（Layer1〜5）で動作する**ため、生成物が医療法に準拠する責任を負う。

## 医療法対応

### このシステム自身（spm-dev-agent コード）

- 通常の Web アプリ規律（認証・暗号化・OWASP）のみ。医療データなし。
- ただし spawn する Claude Code プロセスに `~/.claude/skills/spm-*` の医療スキルが自動ロードされるため、生成コードは医療準拠を満たす設計が出る。

### このエージェントが生成するコード

spm-dev-agent が他リポジトリ向けに生成するコードは、対象システムの位置づけによって以下のスキルが自動起動する：

- spm-diagnosis 向け生成 → `spm-samd-classification` + `spm-electronic-record-3principles`
- peco-stock 向け生成 → `spm-veterinary-care-act`
- 全般 → `spm-3sho-2gl-check` + `spm-sensitive-personal-info`

### 並列実行（parallel-tick）時の特殊論点

- 並列実行される各パート（startClaudeCodeDetached）にも上記スキルが自動ロードされる
- ECC 等の user scope プラグインも全パートにロードされるため、フック競合・トークン消費に注意
- 医療データ生成・テストデータ作成時は、Faker 等で生成した架空データであることを明示

### コード変更時のチェック

1. [ ] 生成コードのテンプレートに医療法対応の最低限（認証・監査ログ・暗号化）が含まれるか
2. [ ] テストデータ生成は架空データのみか（本物の診療データを fixtures に含めない）
3. [ ] 並列実行ログに患者個人情報が出力されないか

### 自動起動するスキル

このリポジトリで作業中：通常はトリガされない。生成対象が医療システムの場合は対象リポジトリで自動起動する。
