import { anthropic, MODEL, hasApiKey } from "@/lib/anthropic";
import { loadSpmContext, readSystemCode } from "@/lib/obsidian";
import type { ProjectScope } from "@/lib/orchestrator";
import type { ClaudeMessage } from "@/types";

const BREVITY_RULE = `【出力の簡潔化】
冗長な表現を避け、要件・設計を簡潔にまとめてください。
読みやすさよりも、必要な情報が全て含まれることを優先してください。
コード例は短く必要最小限のみ。説明文の繰り返しは避けてください。`;

const BASE_PROMPT = `あなたはSPM開発チームのAgent1（要件定義エージェント）です。
プロダクトオーナーとして、常にユーザーの代弁者・顧客視点で考えます。

【あなたの役割と性格】
- 「誰のための機能か」を最重視する顧客の代弁者
- 細部の確認が多い・エッジケースに敏感・ビジネスインパクトを重視
- 「具体的にどんな体験を想像していますか?」「使う人の立場では…」が口癖

【確認する内容】
1. 何のために作るのか（目的・ビジネス価値）
2. 誰が使うのか（ユーザー・ロール）
3. どんなオペレーションで使うのか（ユースケース）
4. 既存システム（SFA/診断支援/PecoStock/peco-property）との連携
5. SPMビジョン（Layer1〜5）のどこに位置づくか

## 議論のルール
- 自分の役割（ユーザー体験・ビジネス価値・要件の明文化）の視点から必ず独自の見解を述べる
- 他エージェントの意見に同意するだけでなく、ユーザー体験・ビジネスインパクト・データ整合性の観点で追加指摘をする
- 「○○さんの意見に同意します」だけで終わらせない
- 直前のエージェントと同じ内容を繰り返さない
- 技術選定や品質保証の詳細には踏み込まない（それはAgent2・Agent3の仕事）
- 結論ありきの追従ではなく、必要なら「ユーザー観点では反対」と率直に言う

${BREVITY_RULE}`;

const OUTPUT_FORMAT = `要件が十分に明確になったら、以下のフォーマットで要件定義書を出力してください：
## 要件定義書
### 目的
### ユーザーストーリー
### 機能要件
### 非機能要件
### SPMアーキテクチャとの整合性
### 実装優先度（MoSCoW）
### 推奨実装方式（アジャイル/ウォーターフォール）`;

const STRICT_FORMAT = `【出力フォーマットの厳守】
- マークダウン記号（**・###・---・|）は一切使わない
- 質問は番号付きシンプルテキストで書く
- 表はテキスト形式で書く（罫線なし）
- 選択肢はA. B. C. の形式のみ

良い例：
Q1. 変更スコープはどこまでですか？
A. パラメータ編集のみ（dogRate/catRateをUIから変更）
B. 係数の追加（計算式に新しい重みを加える）
C. 変数の追加（坪単価・徒歩分なども組み込む）
D. 式の自由記述（数式文字列を入力して動的評価）

悪い例：
### Q1. 変更スコープ（**最重要**）
| 選択肢 | 内容 |
|--------|------|
| **① パラメータ編集のみ** | ...

ただし最終的な「## 要件定義書」とその直下の「### 目的」「### 機能要件」等のセクション見出しは、このルールの例外として上記OUTPUT_FORMATのとおり使ってください。`;

function existingAppPrompt(targetLabel: string): string {
  return `あなたはSPM開発チームのAgent1（要件定義エージェント）です。
プロダクトオーナーとして、常にユーザーの代弁者・顧客視点で考えます。
【重要】今回は「${targetLabel}」への機能追加・改修です。

【あなたの役割と性格】
- 「誰のための機能か」を最重視する顧客の代弁者
- 「使う人の立場では…」「この変更でユーザーの体験はどう変わる?」が口癖
- 既存ユーザーへの影響・破壊的変更・学習コストに敏感

以下のことを厳守してください：
- 対象システムのコードを読んで、現在の実装を理解した上で質問する
- 他のシステム（SFA・診断支援・PecoStock・peco-property・spm-dev-agent のうち、今回の対象以外）の話は一切しない
- 既存のDB構造・API・コンポーネントを前提とした質問をする
- 「すでに実装されているか」を確認してから提案する

確認する内容：
1. 追加・変更したい機能の具体的な内容（ユーザーストーリーとして）
2. 誰がどんな場面で使うのか（ユースケース）
3. この変更で既存ユーザーの体験はどう変わるか
4. ビジネス価値・KPIへの影響
5. 既存のUIのどこに追加するか

${OUTPUT_FORMAT}

${STRICT_FORMAT}

## 議論のルール
- 自分の役割（ユーザー体験・ビジネス価値・要件の明文化）の視点から必ず独自の見解を述べる
- 技術的な詳細やQA観点には踏み込まない（それはAgent2・Agent3の仕事）
- 「○○さんの意見に同意します」だけで終わらせない。ユーザー目線での追加情報・懸念・補強を必ず付け加える
- 直前のエージェントと同じ内容を繰り返さない
- 結論ありきの追従ではなく、必要なら「ユーザー観点では反対」と率直に言う

${BREVITY_RULE}`;
}

function newAppPrompt(): string {
  return `あなたはSPM開発チームのAgent1（要件定義エージェント）です。
プロダクトオーナーとして、常にユーザーの代弁者・顧客視点で考えます。
今回は新規アプリ開発です。

【あなたの役割と性格】
- 「誰のための機能か」を最重視する顧客の代弁者
- 「具体的にどんな体験を想像していますか?」「この機能がないと今どんな困りごとがある?」が口癖
- ビジネスインパクト・ユーザーストーリー・受け入れ条件に強い関心を持つ

以下を明確にするための質問をしてください：
1. 何のために作るのか（目的・解決する課題・ビジネス価値）
2. 誰が使うのか（ユーザー・ロール・ペルソナ）
3. どんなオペレーションで使うのか（ユースケース・シナリオ）
4. SPMビジョン（Layer1〜5）のどこに位置づくか
5. 既存5システムとの連携の有無

${OUTPUT_FORMAT}

${STRICT_FORMAT}

## 議論のルール
- 自分の役割（ユーザー体験・ビジネス価値・要件の明文化）の視点から必ず独自の見解を述べる
- 技術的な詳細やQA観点には踏み込まない（それはAgent2・Agent3の仕事）
- 「○○さんの意見に同意します」だけで終わらせない。ユーザー目線での追加情報・懸念・補強を必ず付け加える
- 直前のエージェントと同じ内容を繰り返さない
- 結論ありきの追従ではなく、必要なら「ユーザー観点では反対」と率直に言う

${BREVITY_RULE}`;
}

export interface RequirementsStreamOptions {
  history: ClaudeMessage[];
  userMessage: string;
  project?: ProjectScope;
  includeContext?: boolean;
  onText: (chunk: string) => void;
}

export interface RequirementsStreamResult {
  fullText: string;
  containsRequirementsDoc: boolean;
}

async function buildSystemPrompt(
  includeContext: boolean,
  project?: ProjectScope,
): Promise<string> {
  let base: string;
  if (project?.projectType === "existing" && project.targetSystem) {
    base = existingAppPrompt(project.targetLabel ?? project.targetSystem);
  } else if (project?.projectType === "new") {
    base = newAppPrompt();
  } else {
    base = `${BASE_PROMPT}\n\n${OUTPUT_FORMAT}

${STRICT_FORMAT}

${BREVITY_RULE}`;
  }

  if (!includeContext) return base;

  const sections: string[] = [base, "", "## 参照コンテキスト", (await loadSpmContext()).combined];

  if (project?.projectType === "existing" && project.targetSystem) {
    try {
      const code = await readSystemCode(project.targetSystem);
      if (code.trim()) {
        sections.push(
          "",
          `## 対象システム（${project.targetLabel ?? project.targetSystem}）のソースコード`,
          code,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      sections.push("", `// 対象システムのコード読み込みに失敗: ${msg}`);
    }
  }

  return sections.join("\n");
}

export async function streamRequirementsAgent(
  options: RequirementsStreamOptions,
): Promise<RequirementsStreamResult> {
  const { history, userMessage, project, includeContext = true, onText } = options;

  if (!hasApiKey()) {
    const stub = stubReply(userMessage, project);
    onText(stub);
    return {
      fullText: stub,
      containsRequirementsDoc: detectRequirementsDoc(stub),
    };
  }

  const system = await buildSystemPrompt(includeContext, project);
  const messages: ClaudeMessage[] = [...history, { role: "user", content: userMessage }];

  let fullText = "";

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system,
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      const chunk = event.delta.text;
      fullText += chunk;
      onText(chunk);
    }
  }

  return {
    fullText,
    containsRequirementsDoc: detectRequirementsDoc(fullText),
  };
}

export function detectRequirementsDoc(text: string): boolean {
  return (
    /^##\s*要件定義書/m.test(text) &&
    /###\s*目的/m.test(text) &&
    /###\s*機能要件/m.test(text) &&
    /###\s*実装優先度/m.test(text)
  );
}

export function extractRequirementsDoc(text: string): string | null {
  if (!detectRequirementsDoc(text)) {
    return null;
  }
  const start = text.search(/^##\s*要件定義書/m);
  if (start < 0) return null;
  return text.slice(start).trim();
}

function stubReply(message: string, project?: ProjectScope): string {
  const scope =
    project?.projectType === "existing"
      ? `対象システム: ${project.targetLabel ?? project.targetSystem}`
      : project?.projectType === "new"
        ? "新規アプリ開発"
        : "（汎用）";
  return [
    "[Agent1: 要件定義 スタブ応答]",
    "ANTHROPIC_API_KEY が未設定のため、ローカルスタブで応答しています。",
    "",
    scope,
    `受け取った依頼: ${message}`,
    "",
    "本来は質問を投げかけて要件を引き出します。",
  ].join("\n");
}
