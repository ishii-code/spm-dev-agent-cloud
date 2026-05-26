import { anthropic, MODEL, hasApiKey } from "@/lib/anthropic";
import { loadSpmContext, readSystemCode, SYSTEM_PATHS } from "@/lib/obsidian";
import { checkSecurity } from "@/lib/security";
import type { ClaudeMessage } from "@/types";


export interface ProjectScope {
  projectType: string; // "existing" | "new"
  targetSystem: string | null;
  targetLabel: string | null;
}

export interface OrchestratorStreamOptions {
  userMessage: string;
  history: ClaudeMessage[];
  project?: ProjectScope;
  includeContext?: boolean;
  onText: (chunk: string) => void;
}

export interface OrchestratorStreamResult {
  fullText: string;
  security: ReturnType<typeof checkSecurity>;
}

function otherSystemsList(targetSystem: string | null): string {
  return Object.keys(SYSTEM_PATHS)
    .filter((s) => s !== targetSystem)
    .join("・");
}

const ORCHESTRATOR_CORE = `あなたはSPM開発チームの統括Orchestratorです。
チーム全体を俯瞰し、各エージェントに仕事を振り、議論をまとめる司会・進行役です。

【あなたの役割と性格】
- 俯瞰的・落ち着いている・決断力がある
- チームの議論を整理し、次のステップを明確に指示する
- 詳細な技術判断や要件の細部には踏み込まない（それは各専門エージェントの仕事）

【このターンでやること】
1. 依頼内容を1〜2行で復唱する（何を作るかを端的に）
2. 「要件定義エージェントが詳細を確認します」と伝える
3. それ以上の質問は絶対にしない

ユーザーへの質問は全てAgent1（要件定義エージェント）が担当します。
あなたは絶対に質問しないでください。

出力例：
「peco-propertyのスコア計算ロジックを設定画面で管理できるようにする機能ですね。
要件定義エージェントが詳細を確認します。」

マークダウン記号（**・###・---）は使わない。
回答は3文以内に収める。

## 議論のルール
- 自分の役割（司会・統括）の範囲で発言する
- 技術判断・要件の細部・品質の詳細には踏み込まない
- チームへの指示を出す際は「では○○エージェントが」という形で明示する
- 各エージェントの意見が出揃ったら、要点を整理してまとめる`;

export async function buildOrchestratorSystem(
  includeContext: boolean,
  project?: ProjectScope,
): Promise<string> {
  const sections: string[] = [ORCHESTRATOR_CORE];

  if (project?.projectType === "existing" && project.targetSystem) {
    sections.push(
      "",
      `【対象】今回は「${project.targetLabel ?? project.targetSystem}」への機能追加・改修です。他のシステム（${otherSystemsList(project.targetSystem)}）の話には触れないでください。`,
    );
  } else if (project?.projectType === "new") {
    sections.push("", `【対象】新規アプリ開発の依頼です。`);
  }

  sections.push(
    "",
    `セキュリティに関わるキーワードを検出した場合は復唱の後に「セキュリティ確認が必要な変更を含みます」と一言添えてください（質問はしない）。`,
  );

  if (includeContext) {
    const context = await loadSpmContext();
    sections.push("", "## 参照コンテキスト（Obsidian Vault・復唱の精度向上用）", context.combined);

    if (project?.projectType === "existing" && project.targetSystem) {
      try {
        const code = await readSystemCode(project.targetSystem);
        if (code.trim()) {
          sections.push(
            "",
            `## 対象システム（${project.targetLabel ?? project.targetSystem}）のソースコード（参考）`,
            code,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        sections.push("", `// 対象システムのコード読み込みに失敗: ${msg}`);
      }
    }
  }

  return sections.join("\n");
}

export async function streamOrchestrator(
  options: OrchestratorStreamOptions,
): Promise<OrchestratorStreamResult> {
  const { userMessage, history, project, includeContext = true, onText } = options;

  const security = checkSecurity(userMessage);

  if (!hasApiKey()) {
    const stub = stubReply(userMessage, security.requiresApproval, project);
    onText(stub);
    return { fullText: stub, security };
  }

  const system = await buildOrchestratorSystem(includeContext, project);
  const messages: ClaudeMessage[] = [...history, { role: "user", content: userMessage }];

  let fullText = "";

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 256,
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

  return { fullText, security };
}

function stubReply(
  message: string,
  requiresApproval: boolean,
  project?: ProjectScope,
): string {
  const scope =
    project?.projectType === "existing"
      ? `対象システム: ${project.targetLabel ?? project.targetSystem}`
      : project?.projectType === "new"
        ? "新規アプリ開発"
        : "（汎用）";
  const lines = [
    "[Orchestrator スタブ応答]",
    "ANTHROPIC_API_KEY が未設定のため、ローカルスタブで応答しています。",
    "",
    scope,
    `受け取った依頼: ${message}`,
  ];
  if (requiresApproval) {
    lines.push("", "⚠️ セキュリティ確認が必要なキーワードを検出しました。");
  }
  return lines.join("\n");
}
