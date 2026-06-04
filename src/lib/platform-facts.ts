// 実プラットフォーム事実（接地データ）。Vault 非依存でコード同梱＝常に利用可能。
// 設計エージェント(PM)と実装 runner の system/プロンプトへ必ず注入し、Supabase/Vercel
// 等の幻覚と「既存SPMと統一」の誤主張を防ぐ。指定外スタックの選択は禁止。
//
// この内容が「正」。Obsidian Vault や既存コード読み取りに依存しない（未設定でも接地が効く）。

export const PLATFORM_FACTS = `## 実プラットフォーム事実（厳守・これが唯一の正）

【SPM 本体のスタック】
- データベース：Cloud SQL (PostgreSQL) + Prisma
- 認証：アプリ独自の jose ベース実装（JWT を httpOnly cookie）
- ホスティング / 実行：Cloud Run

【生成する「AI化アプリ」の既定スタック】
- vanilla Next.js（App Router / TypeScript / Tailwind CSS）
- 自己完結：外部DB・環境変数（env）に依存しない
- デプロイ：Cloud Run（buildpacks）
- MVP は無永続でよい。永続化は後付けで Cloud SQL を採用する

【永続化・認証が要件上ほんとうに必須な場合のみ】
- 永続化：Cloud SQL (PostgreSQL) + Prisma を使う
- 認証：アプリ独自の jose 実装を使う

【禁止事項】
- Supabase / Supabase Auth / Vercel は使用しない（選定・提案も禁止）
- 上記で指定していないスタック（別のBaaS・別ホスティング・別認証基盤）を勝手に選ばない
- 「既存SPMと統一」等の主張は、上記の事実に一致する場合のみ。事実に反する統一主張をしない

【OS統合（単一ログインを壊さない）】
- 生成するアプリには独自のログイン/認証を入れない（SPMの単一ログインを前提にする）
- 認証が必要なら SPM のセッションに乗る前提で設計する（独自ログイン画面を作らない）`;

// プロンプト先頭へ接地事実を前置する（実装 runner 用）。
export function withPlatformFacts(prompt: string): string {
  return `${PLATFORM_FACTS}\n\n---\n\n${prompt}`;
}
