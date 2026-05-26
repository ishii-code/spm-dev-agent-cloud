import { anthropic, MODEL, hasApiKey } from "@/lib/anthropic";
import { loadSpmContext } from "@/lib/obsidian";
import type { ClaudeMessage } from "@/types";

const BREVITY_RULE = `【出力の簡潔化】
冗長な表現を避け、要件・設計を簡潔にまとめてください。
読みやすさよりも、必要な情報が全て含まれることを優先してください。
コード例は短く必要最小限のみ。説明文の繰り返しは避けてください。`;

const PM_SYSTEM_PROMPT = `あなたはSPM開発チームのAgent2（設計・PMエージェント）です。
エンジニア兼プロジェクトマネージャーとして、論理的・現実主義で考えます。

【あなたの役割と性格】
- 技術的な現実主義者。「この設計だと○○のリスクがある」「実装コストは△時間」が口癖
- リスク認識が強く、遠慮なく問題点を指摘する
- 技術負債・スケーラビリティ・保守性・デッドラインを常に意識する
- Agent1が出した要件を技術的に実現可能かどうか評価し、現実的な計画に落とし込む

Agent1が作成した要件定義書を受け取り、以下を実行してください：

1. アジャイル/ウォーターフォールの判断（根拠を明記）
   - アジャイル：要件が変動しやすい・2週間以内に動くものが必要・小規模
   - ウォーターフォール：要件確定・外部連携多い・医療系規制対応・大規模

2. タスク分解（WBS）
   - 各タスクに見積もり時間を付ける
   - 依存関係を明記する
   - 優先度（Must/Should/Could）を設定
   - 技術的リスクの高いタスクには「⚠️リスク」を付ける

3. スプリント計画（アジャイルの場合）
   - Sprint1（1週目）：MVP最小機能
   - Sprint2（2週目）：機能追加・改善

4. Claude Codeへの実装プロンプト生成
   - 単一コードブロック（\`\`\`）で出力
   - tsc --noEmit / next build の確認を含める
   - 既存システム（SFA/診断支援/PecoStock/peco-property）との整合性を考慮

出力フォーマット：
## 設計・開発計画書
### 開発方式
### WBS（タスク一覧）
### スプリント計画
### Claude Code実装プロンプト

## 議論のルール
- 自分の役割（技術設計・工数見積もり・リスク評価）の視点から必ず独自の見解を述べる
- Agent1の要件に対して「技術的に実現可能か」「コストは妥当か」「リスクは何か」を建設的に指摘する
- 「○○さんの意見に同意します」だけで終わらせない。技術的な追加情報・懸念・代替案を付け加える
- 直前のエージェントと同じ内容を繰り返さない
- 要件定義・品質保証の詳細には踏み込まない（それはAgent1・Agent3の仕事）
- 楽観的な見積もりをせず、現実的なリスクを率直に伝える

${BREVITY_RULE}`;

export interface PmStreamOptions {
  history: ClaudeMessage[];
  requirementsDoc: string;
  includeContext?: boolean;
  onText: (chunk: string) => void;
}

export interface PmStreamResult {
  fullText: string;
  containsPlanDoc: boolean;
}

export async function streamPmAgent(
  options: PmStreamOptions,
): Promise<PmStreamResult> {
  const { history, requirementsDoc, includeContext = true, onText } = options;

  if (!hasApiKey()) {
    const stub = stubReply();
    onText(stub);
    return { fullText: stub, containsPlanDoc: detectPlanDoc(stub) };
  }

  const system = includeContext
    ? [PM_SYSTEM_PROMPT, "", "## 参照コンテキスト", (await loadSpmContext()).combined].join("\n")
    : PM_SYSTEM_PROMPT;

  const userMessage = [
    "以下の要件定義書をもとに、設計・開発計画書を作成してください。",
    "",
    requirementsDoc,
  ].join("\n");

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

  return { fullText, containsPlanDoc: detectPlanDoc(fullText) };
}

const PLAN_DOC_SIGNALS: RegExp[] = [
  /設計[・･]?開発計画書|設計・?開発計画|設計書/,
  /開発方式|採用方式|実装方式/,
  /WBS|タスク一覧|タスク分解|作業分解/,
  /スプリント|sprint|フェーズ|工数|見積/i,
];

export function detectPlanDoc(text: string): boolean {
  // 明らかに短いものは設計書ではない
  if (text.length < 1500) return false;

  // 4つのシグナルのうち3つ以上含まれていれば設計書とみなす
  const matchCount = PLAN_DOC_SIGNALS.filter((re) => re.test(text)).length;
  return matchCount >= 3;
}

const PLAN_DOC_START_RE =
  /^#{1,4}\s*[^\n]*(?:設計[・･]?開発計画|設計開発計画|設計・?開発|開発計画書|設計書)[^\n]*$/m;

export function extractPlanDoc(text: string): string | null {
  if (!detectPlanDoc(text)) return null;
  // 「設計」「開発計画」を含む最初の見出し行を起点に切り出す
  // 見出しレベル(##/###/####)とサブテキスト(コロン・括弧)の揺れを許容
  const start = text.search(PLAN_DOC_START_RE);
  if (start < 0) return text.trim();
  return text.slice(start).trim();
}

/**
 * 「### Claude Code実装プロンプト」セクション内の最初のコードフェンス内容を返す。
 * 見出しが無い場合はテキスト全体の最初のコードフェンスを返す（フォールバック）。
 */
export function extractImplementationPrompt(text: string): string | null {
  const sectionMatch = text.match(/###\s*Claude\s*Code[^\n]*\n([\s\S]+)$/i);
  const body = sectionMatch ? sectionMatch[1] : text;
  const fence = body.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // フォールバック: コードフェンスが無ければセクション全体
  return sectionMatch ? sectionMatch[1].trim() : null;
}

function stubReply(): string {
  return [
    "## 設計・開発計画書",
    "[Agent2: 設計・PM スタブ応答]",
    "ANTHROPIC_API_KEY が未設定のため、ローカルスタブで応答しています。",
    "",
    "### 開発方式",
    "アジャイル（スタブ判定）",
    "",
    "### WBS（タスク一覧）",
    "- [Must] スタブタスク1（1h）",
    "- [Should] スタブタスク2（2h）",
    "",
    "### スプリント計画",
    "- Sprint1: スタブタスク1",
    "- Sprint2: スタブタスク2",
    "",
    "### Claude Code実装プロンプト",
    "```",
    "echo 'stub implementation prompt'",
    "```",
  ].join("\n");
}
