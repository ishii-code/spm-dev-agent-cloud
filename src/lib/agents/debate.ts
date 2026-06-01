import { anthropic, MODEL, hasApiKey, describeAiError } from "../anthropic";
import { openai, OPENAI_MODEL, hasOpenAiKey } from "../openai";

export type Domain = "medical" | "payment" | "security" | "personal_info" | "general";

export function detectDomains(userRequest: string, targetLabel: string): Domain[] {
  const text = (userRequest + " " + targetLabel).toLowerCase();
  const domains: Domain[] = [];
  if (/医療|クリニック|病院|カルテ|診療|獣医|患者|処方/.test(text)) domains.push("medical");
  if (/pos|決済|会計|支払|stripe|クレジット|カード|請求|レジ/.test(text)) domains.push("payment");
  if (/個人情報|氏名|住所|電話|メール|マイナンバー|顧客情報/.test(text)) domains.push("personal_info");
  if (/認証|ログイン|パスワード|権限|管理者|セキュリティ|暗号/.test(text)) domains.push("security");
  return domains.length > 0 ? domains : ["general"];
}

const DOMAIN_KNOWLEDGE: Record<Domain, string> = {
  medical: `
【医療システム専門知識】
- 個人情報保護法の要配慮個人情報（医療情報）に該当
- 厚生労働省「医療情報システムの安全管理に関するガイドライン第6版」への準拠
- 患者情報の取得・利用・第三者提供に対する同意設計
- 診療情報の保存期間（最低5年）と削除ポリシー
- アクセスログの完全記録（誰が・いつ・何を参照/変更したか）
- 医師・看護師・事務など役割別アクセス制御（RBAC）
`,
  payment: `
【決済システム専門知識】
- PCI DSS（Payment Card Industry Data Security Standard）準拠必須
- カード情報の非保持化またはトークナイゼーション
- TLS 1.3による通信暗号化
- 不正利用検知・リアルタイムアラート
- 返金・取消処理の監査証跡
- Stripe・PAYJPなど外部決済APIのWebhook署名検証
- 二重決済防止（冪等性キー）
`,
  personal_info: `
【個人情報保護専門知識】
- 個人情報保護法（2022年改正）への完全準拠
- データ取得時の明示的な同意取得フロー
- 保存データのAES-256暗号化
- 個人情報の第三者提供・委託の記録
- 削除要求への対応（忘れられる権利）
- 漏洩時の72時間以内の報告義務
`,
  security: `
【セキュリティ設計専門知識】
- OWASP Top 10への対策
- 多要素認証（MFA）の実装
- セッション管理（タイムアウト・固定化攻撃対策）
- SQLインジェクション・XSS・CSRF対策
- レートリミット・ブルートフォース対策
- セキュリティヘッダー（CSP・HSTS・X-Frame-Options）
`,
  general: "",
};

function buildDomainKnowledgeBlock(domains: Domain[]): string {
  const knowledge = domains
    .filter((d) => d !== "general")
    .map((d) => DOMAIN_KNOWLEDGE[d])
    .join("\n");
  return knowledge
    ? `\n\n【今回のシステムに関連する専門知識（必ず議論に反映すること）】\n${knowledge}`
    : "";
}

const AGENTS = {
  requirements: {
    name: "Agent1（要件）",
    emoji: "🔍",
    systemPrompt: (context: string, history: string, isFirst: boolean) => `
あなたはSPM開発チームの要件定義エージェントです。
視点：ビジネス価値・ユーザー体験・目的の明確化

${context}

これまでの議論：
${history || "（まだ議論なし）"}

${
  isFirst
    ? "あなたが最初の発言者です。依頼内容について要件視点で意見を述べてください。"
    : "直前のエージェントの発言に必ず言及してから（同意・反論・補足）、自分の視点を追加してください。"
}

ルール：
- 他のエージェントの名前を出して「〜さんの言う通り」「〜の点は重要だが」などと言及する
- ユーザーへの確認が必要な場合は【ユーザー確認】と明記
- 合意できた点は【合意】と明記
- マークダウン記号なし
- 200文字以内で簡潔に
`,
  },
  pm: {
    name: "Agent2（設計）",
    emoji: "📋",
    systemPrompt: (context: string, history: string, _isFirst: boolean) => `
あなたはSPM開発チームの設計・PMエージェントです。
視点：技術的実現性・既存システムとの整合性・実装優先度

${context}

これまでの議論：
${history || "（まだ議論なし）"}

直前のAgent1（要件）の発言に必ず言及してから（同意・反論・補足）、設計視点の意見を追加してください。

ルール：
- Agent1の発言を受けて「Agent1の言う通りで、設計的には〜」などと具体的に言及する
- 技術的な懸念や実装方針を述べる
- ユーザーへの確認が必要な場合は【ユーザー確認】と明記
- マークダウン記号なし
- 200文字以内で簡潔に
`,
  },
  qa: {
    name: "Agent3（QA）",
    emoji: "✅",
    systemPrompt: (context: string, history: string, _isFirst: boolean) => `
あなたはSPM開発チームのQA・セキュリティエージェントです。
視点：品質・セキュリティ・テスト容易性・リスク

${context}

これまでの議論：
${history || "（まだ議論なし）"}

Agent1（要件）とAgent2（設計）の発言を踏まえて、QA視点の意見を述べてください。

ルール：
- 「Agent1とAgent2の議論を踏まえると」などと両者に言及する
- 品質・セキュリティリスクを指摘する
- ユーザーへの確認が必要な場合は【ユーザー確認】と明記
- 合意できる点は【合意】と明記
- マークダウン記号なし
- 200文字以内で簡潔に
`,
  },
} as const;

export type AgentType = keyof typeof AGENTS;

async function agentSpeak(
  agentType: AgentType,
  context: string,
  discussionHistory: string,
  isFirst: boolean,
  domains: Domain[],
  onOutput: (agentType: string, text: string) => void,
): Promise<string> {
  const agent = AGENTS[agentType];
  let opinion = "";

  const systemPrompt =
    agent.systemPrompt(context, discussionHistory, isFirst) + buildDomainKnowledgeBlock(domains);

  if (!hasApiKey()) {
    throw new Error(
      "設定エラー：ANTHROPIC_API_KEY が未設定です。Cloud Run のシークレット設定を確認してください",
    );
  }

  console.log(`[ORCHESTRATOR] Anthropic呼出 agent=${agentType} model=${MODEL}`);
  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: "発言してください。" }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        opinion += event.delta.text;
        onOutput(agentType, event.delta.text);
      }
    }
  } catch (e) {
    console.error(`[ORCHESTRATOR] Anthropic呼出失敗 agent=${agentType}:`, e);
    throw new Error(describeAiError(e));
  }

  console.log(`[ORCHESTRATOR] レスポンス agent=${agentType} len=${opinion.length}`);
  return opinion;
}

export async function runDebateRound(
  context: string,
  discussionHistory: string,
  roundNumber: number,
  domains: Domain[],
  onOutput: (agentType: string, text: string) => void,
): Promise<string> {
  let roundHistory = discussionHistory;
  const agentOrder: AgentType[] = ["requirements", "pm", "qa"];

  for (let i = 0; i < agentOrder.length; i++) {
    const agentType = agentOrder[i];
    const agent = AGENTS[agentType];

    onOutput(agentType, "");

    const opinion = await agentSpeak(
      agentType,
      context,
      roundHistory,
      i === 0 && roundNumber === 1,
      domains,
      onOutput,
    );

    roundHistory += `\n\n${agent.name}：${opinion}`;

    await new Promise((r) => setTimeout(r, 500));
  }

  return roundHistory;
}

export type OrchestratorAction = "continue_debate" | "ask_user" | "finalize";

export interface OrchestratorJudgment {
  action: OrchestratorAction;
  content: string;
  questions?: string[];
}

export async function orchestratorJudge(
  context: string,
  fullHistory: string,
  domains: Domain[] = ["general"],
): Promise<OrchestratorJudgment> {
  const domainNames = domains.filter((d) => d !== "general").join("・");
  const domainNote = domainNames
    ? `\n\n以下のドメインに関連するシステムです：${domainNames}\nこれらの専門要件（セキュリティ・法規制・業界標準）が要件定義に含まれているか確認してください。\n不足している場合はcontinue_debateを選んでください。`
    : "";

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 800,
      messages: [
        {
          role: "system",
          content:
            `SPM開発OrchestratorとしてJSON形式のみで返答してください。\n` +
            `必ず以下の形式で返答：{"action":"continue_debate","content":"理由","questions":[]}\n` +
            `actionは continue_debate / ask_user / finalize のいずれか。\n` +
            `第1ラウンドは必ず ask_user。全員合意のみ finalize。\n\n` +
            `questions のフォーマット（必須）：\n` +
            `各質問は必ず以下の形式の1つの文字列として出力すること：\n` +
            `Q1\n質問テキスト（1行）\nA 選択肢A\nB 選択肢B\nC 選択肢C（「未定・その他」を常に入れる）\n\n` +
            `選択肢は必ず3つ以上。自由記述のみの質問は禁止。\n` +
            `ごうさんが素早く答えられるように選択肢を具体的にすること。` +
            (domainNames ? `\n関連ドメイン：${domainNames}` : "") +
            domainNote,
        },
        {
          role: "user",
          content: `${context}\n\n議論：\n${fullHistory.slice(-3000)}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    console.log("[DEBATE] raw response:", text.slice(0, 300));

    if (!text.trim()) {
      console.error("[DEBATE] Empty response from OpenAI");
      return { action: "ask_user", content: "レスポンスが空でした", questions: [] };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonStr) as Partial<OrchestratorJudgment>;
      const rawAction = (parsed.action ?? "continue_debate") as string;
      const action: OrchestratorAction =
        rawAction === "ask_user" || rawAction === "finalize"
          ? rawAction
          : "continue_debate";
      return {
        action,
        content: parsed.content ?? "",
        questions: Array.isArray(parsed.questions)
          ? parsed.questions.filter((q): q is string => typeof q === "string")
          : [],
      };
    } catch (parseError) {
      console.error("[DEBATE] JSON parse error:", parseError);
      console.error("[DEBATE] raw:", jsonStr.slice(0, 200));
      return { action: "ask_user", content: "解析エラー", questions: [] };
    }
  } catch (e) {
    console.error("[DEBATE] orchestratorJudge API error:", e);
    return { action: "ask_user", content: "APIエラー", questions: [] };
  }
}

export async function createRequirementsDoc(
  context: string,
  fullHistory: string,
  onOutput: (agentType: string, text: string) => void,
): Promise<string> {
  let doc = "";
  onOutput("orchestrator", "");

  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    stream: true,
    max_completion_tokens: 1500,
    messages: [
      {
        role: "system",
        content: `あなたはSPM開発プロジェクトのOrchestratorです。
3エージェントの議論を踏まえて要件定義書を作成してください。
マークダウン記号なし。`,
      },
      {
        role: "user",
        content: `${context}\n\n議論全体：\n${fullHistory}\n\n
以下の形式で要件定義書を作成してください：

要件定義書

目的
[記載]

ユーザーストーリー
[記載]

機能要件
[記載]

非機能要件
[記載]

実装優先度（MoSCoW）
Must: [記載]
Should: [記載]
Could: [記載]

リスクと対策
[記載]

議論で合意した点
[エージェント間で【合意】となった内容を列挙]

ごうさんへ
この要件定義でよろしいですか？承認いただければ設計・実装フェーズに進みます。`,
      },
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (text) {
      doc += text;
      onOutput("orchestrator", text);
    }
  }

  return doc;
}

export async function runDynamicDebate(
  userRequest: string,
  systemCode: string,
  targetLabel: string,
  projectType: string,
  onOutput: (agentType: string, text: string) => void,
  onUserQuestion: (questions: string[]) => void,
  getUserAnswer: () => Promise<string>,
): Promise<string> {
  const context = `
開発依頼：${userRequest}
対象システム：${targetLabel}（${projectType === "existing" ? "既存システムへの追加" : "新規開発"}）
既存コード概要：${systemCode.substring(0, 2000)}
`;

  const domains = detectDomains(userRequest, targetLabel);
  const domainNames = domains.filter((d) => d !== "general").join("・");
  if (domainNames) {
    onOutput(
      "orchestrator",
      `検出されたドメイン：${domainNames}\n専門知識を議論に反映します。\n`,
    );
  }

  let fullHistory = "";
  const maxRounds = 3;
  let round = 0;

  while (round < maxRounds) {
    round++;
    onOutput("orchestrator", `\n--- ラウンド${round} ---\n`);

    fullHistory = await runDebateRound(context, fullHistory, round, domains, onOutput);

    const judgment = await orchestratorJudge(context, fullHistory, domains);
    onOutput("orchestrator", `\n[Orchestrator判断: ${judgment.content}]\n`);

    if (judgment.action === "finalize") {
      break;
    }

    if (judgment.action === "ask_user" && judgment.questions && judgment.questions.length > 0) {
      onUserQuestion(judgment.questions);
      const answer = await getUserAnswer();
      fullHistory += `\n\nごうさんへの確認と回答：\n${judgment.questions.join("\n")}\n\nごうさんの回答：${answer}`;

      onOutput("orchestrator", "\n--- 回答を踏まえて再議論 ---\n");
      fullHistory = await runDebateRound(context, fullHistory, round + 0.5, domains, onOutput);
      break;
    }
  }

  onOutput("orchestrator", "\n--- 要件定義書を作成します ---\n");
  const doc = await createRequirementsDoc(context, fullHistory, onOutput);

  return doc;
}

export async function generateInitialInterview(
  userRequest: string,
  systemCode: string,
  targetLabel: string,
  projectType: string,
  onOutput: (agentType: string, text: string) => void,
): Promise<string> {
  console.log(
    `[ORCHESTRATOR] 受信 generateInitialInterview targetLabel=${targetLabel} projectType=${projectType} reqLen=${userRequest.length}`,
  );
  const domains = detectDomains(userRequest, targetLabel);
  const domainNames = domains.filter((d) => d !== "general").join("・");
  if (domainNames) {
    onOutput(
      "orchestrator",
      `検出されたドメイン：${domainNames}\n専門知識を議論に反映します。\n`,
    );
  }

  const [req, pm, qa] = await Promise.all([
    agentSpeak(
      "requirements",
      `依頼：${userRequest}\n対象：${targetLabel}（${projectType === "existing" ? "既存" : "新規"}）`,
      "",
      true,
      domains,
      () => {},
    ),
    agentSpeak(
      "pm",
      `依頼：${userRequest}\n対象：${targetLabel}\nコード：${systemCode.substring(0, 500)}`,
      "",
      true,
      domains,
      () => {},
    ),
    agentSpeak(
      "qa",
      `依頼：${userRequest}\n対象：${targetLabel}`,
      "",
      true,
      domains,
      () => {},
    ),
  ]);

  let interview = "";
  onOutput("orchestrator", "");

  if (!hasOpenAiKey()) {
    throw new Error(
      "設定エラー：OPENAI_API_KEY が未設定です。Cloud Run のシークレット設定を確認してください",
    );
  }
  console.log(`[ORCHESTRATOR] OpenAI呼出 model=${OPENAI_MODEL}`);

  try {
  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    stream: true,
    max_completion_tokens: 800,
    messages: [
      {
        role: "system",
        content: `SPM開発エージェントのOrchestratorです。
3エージェントの意見を整理してごうさんへの初期確認事項をまとめてください。

冒頭に「全体像を把握するため確認させてください。」と書く。

各質問は必ず以下の形式で出力（マークダウン記号・太字・箇条書き記号は一切使わない）：
Q1
質問テキスト（1行）
A 選択肢A
B 選択肢B
C 選択肢C（最後の選択肢には「未定・その他」を含める）

選択肢は必ず3つ以上。自由記述のみの質問は禁止。
質問の重複を排除。最大5問。
ごうさんが素早く答えられるように選択肢を具体的にすること。`,
      },
      {
        role: "user",
        content: `依頼：${userRequest}\n対象：${targetLabel}\n\nAgent1意見：${req}\nAgent2意見：${pm}\nAgent3意見：${qa}`,
      },
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (text) {
      interview += text;
      onOutput("orchestrator", text);
    }
  }
  } catch (e) {
    console.error("[ORCHESTRATOR] OpenAI呼出失敗:", e);
    throw new Error(describeAiError(e));
  }

  console.log(
    `[ORCHESTRATOR] レスポンス orchestrator(OpenAI) len=${interview.length}`,
  );
  return interview;
}

export async function runDebate(
  topic: string,
  requirements: string,
  systemCode: string,
  onOutput: (agentType: string, text: string) => void,
): Promise<string> {
  const context = `議題：${topic}\n要件：${requirements}\n既存コード：${systemCode.substring(0, 2000)}`;
  const domains = detectDomains(`${topic} ${requirements}`, "");
  let history = "";

  history = await runDebateRound(context, history, 1, domains, onOutput);

  let summary = "";
  onOutput("orchestrator", "");

  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    stream: true,
    max_completion_tokens: 600,
    messages: [
      {
        role: "system",
        content: `SPM開発エージェントのOrchestratorです。
議論を踏まえた最終提案とごうさんへの確認事項を出力してください。
マークダウン記号なし。`,
      },
      { role: "user", content: `${context}\n\n議論：\n${history}` },
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (text) {
      summary += text;
      onOutput("orchestrator", text);
    }
  }

  return summary;
}
