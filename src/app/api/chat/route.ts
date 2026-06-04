import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/project-access";
import { createSSEStream } from "@/lib/sse";
import { extractPlanDoc, streamPmAgent } from "@/lib/agents/pm";
import {
  createRequirementsDoc,
  detectDomains,
  generateInitialInterview,
  orchestratorJudge,
  runDebateRound,
  type Domain,
} from "@/lib/agents/debate";
import { projectDocPath, readSystemCode, writeVaultFile } from "@/lib/obsidian";
import { processMessageUrls } from "@/lib/url-fetch";
import { validateChatRequest } from "@/lib/validation";
import type { ClaudeMessage } from "@/types";

export const runtime = "nodejs";

interface DebateCtx {
  originalRequest: string;
  phase: "initial_interview" | "debate";
  fullHistory: string;
  pendingQuestions?: string[];
  domains?: string[];
  currentRound?: number;
  awaitingContinuation?: boolean;
}

function readDebateCtx(raw: unknown): DebateCtx | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.originalRequest !== "string") return null;
  const phase = obj.phase === "debate" ? "debate" : "initial_interview";
  return {
    originalRequest: obj.originalRequest,
    phase,
    fullHistory: typeof obj.fullHistory === "string" ? obj.fullHistory : "",
    pendingQuestions: Array.isArray(obj.pendingQuestions)
      ? obj.pendingQuestions.filter((q): q is string => typeof q === "string")
      : undefined,
    domains: Array.isArray(obj.domains)
      ? obj.domains.filter((d): d is string => typeof d === "string")
      : undefined,
    currentRound: typeof obj.currentRound === "number" ? obj.currentRound : undefined,
    awaitingContinuation: obj.awaitingContinuation === true,
  };
}

type SSEAgentKey = "orchestrator" | "agent1" | "agent2" | "agent3";

function agentTypeToSseKey(agentType: string): SSEAgentKey | null {
  switch (agentType) {
    case "orchestrator":
      return "orchestrator";
    case "requirements":
      return "agent1";
    case "pm":
      return "agent2";
    case "qa":
      return "agent3";
    default:
      return null;
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const result = validateChatRequest(body);
  if (!result.ok) {
    return Response.json({ error: "validation_failed", details: result.errors }, { status: 400 });
  }

  const { sessionId, projectId, message } = result.value;

  // 書込/実行の認可（ADMIN 全許可 / owner 本人 / null-owner レガシー開放 / 他人 403）
  const access = await requireProjectAccess(projectId);
  if (!access.ok) return access.response;

  console.log(
    `[ORCHESTRATOR] 受信 POST /api/chat projectId=${projectId} sessionId=${sessionId} msgLen=${message.length}`,
  );

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { project: true },
  });
  if (!session) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }
  if (session.projectId !== projectId) {
    return Response.json({ error: "session_project_mismatch" }, { status: 409 });
  }

  const previousMessages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });

  await prisma.message.create({
    data: { sessionId, role: "user", content: message },
  });

  return createSSEStream(async (send) => {
    const status = session.status;
    const isFirstMessage =
      previousMessages.filter((m) => m.role === "user").length === 0;
    const targetLabel = session.project.targetLabel ?? session.project.targetSystem ?? "";

    console.log(
      "[CHAT] status:",
      status,
      "| isFirst:",
      isFirstMessage,
      "| skipRequirements:",
      session.project.skipRequirements,
      "| message:",
      message.slice(0, 80),
    );

    let systemCode = "";
    if (session.project.targetSystem) {
      try {
        systemCode = await readSystemCode(session.project.targetSystem);
      } catch {
        // ignore
      }
    }

    const emitText = (agentType: string, text: string) => {
      const key = agentTypeToSseKey(agentType);
      if (!text) {
        if (key) send({ type: "agent", data: { agent: key, status: "streaming" } });
        return;
      }
      if (key) send({ type: "text", data: { agent: key, chunk: text } });
    };

    // ===================================================================
    // URL 取り扱い（Phase2）：発言中の URL を取得試行。読めたら本文をモデル入力へ
    // 注入（要約せず上限付き）、読めない/失敗は黙殺せず理由バブル＋推測禁止ガード。
    // DB 保存値・originalRequest は汚さず、モデル入力にのみ後付けする。
    // ===================================================================
    const urlResult = await processMessageUrls(message);
    const urlModelExtra = [urlResult.injection, urlResult.guard]
      .filter(Boolean)
      .join("\n\n");
    if (urlResult.notice) {
      send({ type: "text", data: { agent: "orchestrator", chunk: urlResult.notice } });
      await prisma.message.create({
        data: {
          sessionId,
          role: "orchestrator",
          content: urlResult.notice,
          agentType: "orchestrator",
          metadata: { phase: "url_notice" },
        },
      });
      // 後続の phase_start が orchestrator バッファをクリアするため、
      // この通知バブルは確定し、本処理は新規バブルに分離される。
    }

    // ===================================================================
    // PM (Agent2) helper：approved 後の設計書生成・保存・完了処理
    // ===================================================================
    const runPmFlow = async (reqDoc: string, originalRequest: string) => {
      send({ type: "phase_start", data: { phase: "design", label: "📝 設計書を生成中..." } });
      send({ type: "agent_start", data: { agentType: "pm", label: "Agent2 設計・PM" } });
      send({ type: "agent", data: { agent: "agent2", status: "thinking" } });

      const pmHistory: ClaudeMessage[] = [
        { role: "user", content: originalRequest },
        { role: "assistant", content: reqDoc },
      ];

      const agent2 = await streamPmAgent({
        history: pmHistory,
        requirementsDoc: reqDoc,
        onText: (chunk) => {
          send({ type: "text", data: { agent: "agent2", chunk } });
        },
      });

      await prisma.message.create({
        data: { sessionId, role: "agent2", content: agent2.fullText, agentType: "pm" },
      });
      send({ type: "agent_complete", data: { agentType: "pm" } });

      if (agent2.containsPlanDoc) {
        const rawPlanDoc = extractPlanDoc(agent2.fullText) ?? agent2.fullText;
        if (rawPlanDoc.length < 200) {
          send({
            type: "warning",
            data: {
              message: `設計書の生成が途中で切れました (${rawPlanDoc.length}文字)。再度送信してください。`,
            },
          });
        } else {
          const planRelative = projectDocPath(
            {
              title: session.project.title,
              projectType: session.project.projectType,
              targetLabel: session.project.targetLabel,
            },
            "02_設計・スプリント計画.md",
          );
          let planAbsolute: string | null = null;
          try {
            planAbsolute = await writeVaultFile(planRelative, rawPlanDoc);
          } catch (error) {
            const msg = error instanceof Error ? error.message : "unknown";
            send({ type: "error", data: { message: `Obsidian書込失敗: ${msg}` } });
          }
          const savedPlan = await prisma.document.create({
            data: {
              projectId,
              type: "sprint",
              title: "設計・スプリント計画",
              content: rawPlanDoc,
              obsidianPath: planAbsolute,
            },
          });
          send({
            type: "document",
            data: {
              id: savedPlan.id,
              type: savedPlan.type,
              title: savedPlan.title,
              obsidianPath: savedPlan.obsidianPath,
            },
          });
        }
      }

      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "completed" },
      });
    };

    // ===================================================================
    // ケース0: skipRequirements モード → 直接 PM へ
    // ===================================================================
    if (session.project.skipRequirements) {
      send({
        type: "phase_start",
        data: { phase: "design", label: "⚡ 直接実装モード（設計書生成中）" },
      });
      const reqDoc = isFirstMessage
        ? message
        : (previousMessages.find((m) => m.role === "user")?.content ?? message);
      // URL ガードはモデル入力（設計書生成元）にだけ付与。保存用 originalRequest は元のまま。
      const reqDocForModel = urlModelExtra ? `${reqDoc}\n\n${urlModelExtra}` : reqDoc;
      await runPmFlow(reqDocForModel, reqDoc);
      send({ type: "phase_complete", data: { phase: "design" } });
      send({ type: "done", data: { sessionId } });
      return;
    }

    // ===================================================================
    // ケース1: 最初のメッセージ → 初期ヒアリングだけ実行して停止
    // ===================================================================
    // status==="active" は「初期ヒアリングがまだ一度も成立していない」状態。
    // 最初の送信が AI 例外で失敗すると user メッセージだけ保存され status は active の
    // まま残り、次の送信は isFirstMessage=false でケース4（誤った「設計書完成」表示）に
    // 落ちる。これを防ぐため、active のセッションは isFirstMessage に関わらず再ヒアリングする。
    if (isFirstMessage || status === "active") {
      console.log(
        `[ORCHESTRATOR] generateInitialInterview開始 sessionId=${sessionId} isFirst=${isFirstMessage} status=${status}`,
      );
      send({
        type: "phase_start",
        data: { phase: "initial_interview", label: "💬 全体像を把握するため確認します..." },
      });
      send({ type: "agent_start", data: { agentType: "orchestrator", label: "Orchestrator" } });
      send({ type: "agent", data: { agent: "orchestrator", status: "thinking" } });

      // URL ガードはモデル入力にだけ付与（DB の user メッセージ・originalRequest は元のまま）。
      const interviewInput = urlModelExtra ? `${message}\n\n${urlModelExtra}` : message;
      const interview = await generateInitialInterview(
        interviewInput,
        systemCode,
        targetLabel,
        session.project.projectType,
        emitText,
      );

      await prisma.message.create({
        data: {
          sessionId,
          role: "orchestrator",
          content: interview,
          agentType: "orchestrator",
          metadata: { phase: "initial_interview" },
        },
      });
      console.log(
        `[ORCHESTRATOR] Message保存 sessionId=${sessionId} role=orchestrator len=${interview.length}`,
      );
      console.log(`[ORCHESTRATOR] generateInitialInterview完了 sessionId=${sessionId}`);

      await prisma.session.update({
        where: { id: sessionId },
        data: {
          status: "waiting_user",
          debateContext: {
            originalRequest: message,
            phase: "initial_interview",
            fullHistory: "",
          },
        },
      });

      send({ type: "agent_complete", data: { agentType: "orchestrator" } });
      send({ type: "phase_complete", data: { phase: "initial_interview" } });
      send({ type: "done", data: { sessionId } });
      return;
    }

    // ===================================================================
    // ケース2: waiting_user / initial_interview（互換） → 議論を1POST分回す
    // ===================================================================
    if (status === "waiting_user" || status === "initial_interview" || status === "debate") {
      console.log("[CHAT] ENTERING waiting_user flow (status=" + status + ")");
      const ctx =
        readDebateCtx(session.debateContext) ??
        {
          originalRequest:
            previousMessages.find((m) => m.role === "user")?.content ?? message,
          phase: "initial_interview" as const,
          fullHistory: "",
          pendingQuestions: undefined,
          domains: undefined,
          currentRound: undefined,
          awaitingContinuation: false,
        };

      if (!ctx.originalRequest) {
        console.error("[CHAT] ERROR: missing originalRequest, resetting");
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "initial_interview" },
        });
        send({
          type: "error",
          data: { message: "セッション状態が不正です。最初からやり直してください。" },
        });
        send({ type: "done", data: { sessionId } });
        return;
      }

      const originalRequest = ctx.originalRequest;
      const baseContext =
        `開発依頼：${originalRequest}\n` +
        `対象：${targetLabel}（${session.project.projectType === "existing" ? "既存システムへの追加" : "新規開発"}）\n` +
        `既存コード概要：${systemCode.substring(0, 2000)}` +
        // 読めた URL 本文の注入＋読めない URL の推測禁止ガードをモデル context に付与。
        (urlModelExtra ? `\n\n${urlModelExtra}` : "");

      const domains: Domain[] =
        ctx.domains && ctx.domains.length > 0
          ? (ctx.domains.filter((d) =>
              ["medical", "payment", "security", "personal_info", "general"].includes(d),
            ) as Domain[])
          : detectDomains(originalRequest, targetLabel);

      const currentRound = ctx.currentRound ?? 1;

      // -------- 要件定義書作成ヘルパ --------
      const runFinalize = async (history: string) => {
        send({
          type: "phase_start",
          data: { phase: "requirements", label: "📝 要件定義書を生成中..." },
        });
        send({ type: "agent_start", data: { agentType: "orchestrator", label: "要件定義書作成" } });

        const requirementsDoc = await createRequirementsDoc(baseContext, history, emitText);

        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: requirementsDoc,
            agentType: "orchestrator",
            metadata: { phase: "requirements" },
          },
        });

        const reqRelative = projectDocPath(
          {
            title: session.project.title,
            projectType: session.project.projectType,
            targetLabel: session.project.targetLabel,
          },
          "01_要件定義.md",
        );
        let reqAbsolute: string | null = null;
        try {
          reqAbsolute = await writeVaultFile(reqRelative, requirementsDoc);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "unknown";
          send({ type: "error", data: { message: `Obsidian書込失敗: ${msg}` } });
        }
        const savedReq = await prisma.document.create({
          data: {
            projectId,
            type: "requirements",
            title: "要件定義書",
            content: requirementsDoc,
            obsidianPath: reqAbsolute,
          },
        });
        send({
          type: "document",
          data: {
            id: savedReq.id,
            type: savedReq.type,
            title: savedReq.title,
            obsidianPath: savedReq.obsidianPath,
          },
        });
        send({ type: "agent_complete", data: { agentType: "orchestrator" } });

        const approvalText =
          "要件定義書が完成しました。\n\n" +
          "---\n" +
          "この要件定義で設計・実装に進めてよいですか？\n\n" +
          "A. はい、この要件で進めてください\n" +
          "B. いいえ、修正が必要です（修正したい点を教えてください）\n" +
          "C. 一部修正が必要です（続けて入力してください）\n" +
          "---";
        send({
          type: "text",
          data: { agent: "orchestrator", chunk: `\n${approvalText}\n` },
        });
        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: approvalText,
            agentType: "orchestrator",
            metadata: { phase: "requirements_approval" },
          },
        });
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "requirements_approval" },
        });

        send({ type: "phase_complete", data: { phase: "debate" } });
        send({ type: "done", data: { sessionId } });
      };

      // -------- 入力バリデーション：選択肢への回答として妥当かチェック --------
      // 「あ」など無関係な短文で議論が進むのを防ぐ
      const isValidAnswerToQuestions = (msg: string): boolean => {
        const t = msg.trim();
        if (t.length === 0) return false;
        if (/Q\s*\d+/.test(t)) return true;
        if (/[A-Ea-e][.．:：)）\s]/.test(t)) return true;
        if (/^[A-Ea-e]$/.test(t)) return true;
        if (t.length >= 5) return true;
        return false;
      };
      const isValidContinuation = (msg: string): boolean => {
        const t = msg.trim();
        if (t.length === 0) return false;
        if (/^[a-cA-C]([.．:：)）\s]|$)/.test(t)) return true;
        if (/続ける|追加|作成|continue|requirement|finalize/i.test(t)) return true;
        if (t.length >= 10) return true;
        return false;
      };

      const trimmedForValidation = message.trim();

      const sendInvalidRetry = async (
        rePromptText: string,
        metaPhase: string,
      ) => {
        send({
          type: "text",
          data: { agent: "orchestrator", chunk: `\n${rePromptText}\n` },
        });
        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: rePromptText,
            agentType: "orchestrator",
            metadata: { phase: metaPhase },
          },
        });
        // status / debateContext は変更せず、同じ待機状態を維持
        send({ type: "phase_complete", data: { phase: "debate" } });
        send({ type: "done", data: { sessionId } });
      };

      if (ctx.awaitingContinuation && !isValidContinuation(trimmedForValidation)) {
        console.log("[CHAT] invalid continuation input, re-prompting");
        const continueText =
          "選択肢から選んで回答してください（A/B/C または補足を入力）。\n\n" +
          "続行オプション：\n" +
          "A. このまま議論を続ける\n" +
          "B. 追加の要件や制約を追加する\n" +
          "C. この内容で要件定義書を作成する";
        await sendInvalidRetry(continueText, "debate_continuation_invalid");
        return;
      }

      if (!ctx.awaitingContinuation && !isValidAnswerToQuestions(trimmedForValidation)) {
        console.log("[CHAT] invalid answer input, re-prompting");
        let originalQuestionsText = "";
        if (ctx.pendingQuestions && ctx.pendingQuestions.length > 0) {
          const formattedQuestions = ctx.pendingQuestions
            .map((q, i) => {
              const t = q.trim();
              return /^Q\d+/.test(t) ? t : `Q${i + 1}\n${t}`;
            })
            .join("\n\n");
          originalQuestionsText = "ごうさんへの確認事項：\n\n" + formattedQuestions;
        } else {
          const lastOrch = [...previousMessages]
            .reverse()
            .find((m) => m.role === "orchestrator");
          originalQuestionsText = lastOrch?.content ?? "";
        }
        const rePromptText =
          "選択肢から選んで回答してください（A/B/C または補足を入力）。\n\n" +
          originalQuestionsText;
        await sendInvalidRetry(rePromptText, "answer_invalid");
        return;
      }

      // -------- ユーザー入力を fullHistory に反映 --------
      let currentHistory = ctx.fullHistory ?? "";
      const trimmed = message.trim();

      if (ctx.awaitingContinuation) {
        if (/^c\b|作成|finalize/i.test(trimmed)) {
          // C: そのまま要件定義書作成へ
          console.log("[CHAT] continuation: finalize");
          await runFinalize(currentHistory);
          return;
        }
        if (/^b\b|追加|requirement/i.test(trimmed)) {
          console.log("[CHAT] continuation: add requirements");
          currentHistory += `\n\nごうさんからの追加要件・制約：${message}`;
        } else if (/^a\b|続ける|continue/i.test(trimmed)) {
          console.log("[CHAT] continuation: continue debate");
          // no-op; そのまま次ラウンド
        } else {
          console.log("[CHAT] continuation: free comment");
          currentHistory += `\n\nごうさんからの追加コメント：${message}`;
        }
      } else if (ctx.pendingQuestions && ctx.pendingQuestions.length > 0) {
        currentHistory +=
          `\n\nOrchestratorからの確認：\n${ctx.pendingQuestions.join("\n")}\n` +
          `Orchestratorの確認への回答：${message}`;
      } else {
        const prefix =
          ctx.phase === "initial_interview"
            ? "Orchestratorの初期質問への回答："
            : "Orchestratorの確認への回答：";
        currentHistory += `\n\n${prefix}${message}`;
      }

      // -------- 1ラウンドだけ議論を進める --------
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "debate" },
      });
      send({
        type: "phase_start",
        data: { phase: "debate", label: `💬 ラウンド${currentRound}：エージェントが議論中...` },
      });
      send({
        type: "text",
        data: { agent: "orchestrator", chunk: `\n--- ラウンド${currentRound} ---\n` },
      });
      send({ type: "agent_start", data: { agentType: "debate", label: `ラウンド${currentRound}` } });

      currentHistory = await runDebateRound(
        baseContext,
        currentHistory,
        currentRound,
        domains,
        emitText,
      );
      send({ type: "agent_complete", data: { agentType: "debate" } });

      const judgment = await orchestratorJudge(baseContext, currentHistory, domains, currentRound);
      console.log("[DEBATE] judgment:", JSON.stringify(judgment), "round:", currentRound);

      // 安全網: ラウンド上限に達したら ask_user でも finalize に倒す（同じ質問のループ防止）。
      const MAX_INTERVIEW_ROUNDS = 3;
      if (judgment.action === "ask_user" && currentRound >= MAX_INTERVIEW_ROUNDS) {
        console.log(`[CHAT] round cap (${currentRound}) 到達 → finalize へ強制移行`);
        await runFinalize(currentHistory);
        return;
      }

      send({
        type: "text",
        data: {
          agent: "orchestrator",
          chunk: `\n[Orchestrator判断: ${judgment.content}]\n`,
        },
      });

      // ask_user → 質問して停止
      if (
        judgment.action === "ask_user" &&
        judgment.questions &&
        judgment.questions.length > 0
      ) {
        const formattedQuestions = (judgment.questions as string[])
          .map((q, i) => {
            const t = q.trim();
            return /^Q\d+/.test(t) ? t : `Q${i + 1}\n${t}`;
          })
          .join("\n\n");
        const questionText =
          "ごうさんへの確認事項：\n\n" + formattedQuestions;
        console.log("[CHAT] ask_user emit:", questionText.slice(0, 160));
        send({
          type: "text",
          data: { agent: "orchestrator", chunk: `\n\n${questionText}\n` },
        });
        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: questionText,
            agentType: "orchestrator",
            metadata: { phase: "debate_waiting_user", round: currentRound },
          },
        });
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: "waiting_user",
            debateContext: {
              originalRequest,
              phase: "debate",
              fullHistory: currentHistory,
              pendingQuestions: judgment.questions,
              domains,
              currentRound: currentRound + 1,
              awaitingContinuation: false,
            },
          },
        });
        send({ type: "phase_complete", data: { phase: "debate" } });
        send({ type: "done", data: { sessionId } });
        return;
      }

      // continue_debate → 続行オプションを提示して停止
      if (judgment.action === "continue_debate") {
        const continueText =
          `--- ラウンド${currentRound} 完了 ---\n\n` +
          "続行オプション：\n" +
          "A. このまま議論を続ける\n" +
          "B. 追加の要件や制約を追加する\n" +
          "C. この内容で要件定義書を作成する";
        send({
          type: "text",
          data: { agent: "orchestrator", chunk: `\n\n${continueText}\n` },
        });
        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: continueText,
            agentType: "orchestrator",
            metadata: { phase: "debate_continuation", round: currentRound },
          },
        });
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: "waiting_user",
            debateContext: {
              originalRequest,
              phase: "debate",
              fullHistory: currentHistory,
              domains,
              currentRound: currentRound + 1,
              awaitingContinuation: true,
            },
          },
        });
        send({ type: "phase_complete", data: { phase: "debate" } });
        send({ type: "done", data: { sessionId } });
        return;
      }

      // finalize → 要件定義書作成
      await runFinalize(currentHistory);
      return;
    }

    // ===================================================================
    // ケース3: requirements_approval → 設計書生成 or 議論に戻す
    // ===================================================================
    if (status === "requirements_approval") {
      console.log("[CHAT] ENTERING requirements_approval flow");
      const approved = /(^|[^a-z])a([^a-z]|$)/i.test(message) ||
        /はい|進め|ok/i.test(message);

      if (!approved) {
        send({
          type: "text",
          data: {
            agent: "orchestrator",
            chunk: "\n修正点を教えてください。要件定義を見直します。\n",
          },
        });
        await prisma.message.create({
          data: {
            sessionId,
            role: "orchestrator",
            content: "修正点を教えてください。要件定義を見直します。",
            agentType: "orchestrator",
            metadata: { phase: "requirements_approval_rejected" },
          },
        });
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "waiting_user" },
        });
        send({ type: "done", data: { sessionId } });
        return;
      }

      const latestReq = await prisma.document.findFirst({
        where: { projectId, type: "requirements" },
        orderBy: { updatedAt: "desc" },
      });
      if (!latestReq) {
        console.error("[CHAT] ERROR: requirements doc not found");
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "waiting_user" },
        });
        send({
          type: "error",
          data: { message: "要件定義書が見つかりません。議論からやり直します。" },
        });
        send({ type: "done", data: { sessionId } });
        return;
      }

      const originalRequest =
        previousMessages.find((m) => m.role === "user")?.content ?? message;
      await runPmFlow(latestReq.content, originalRequest);
      send({ type: "phase_complete", data: { phase: "design" } });
      send({ type: "done", data: { sessionId } });
      return;
    }

    // ===================================================================
    // ケース4: その他（completed 等）
    // ※「設計書完成」と案内してよいのは設計書(sprint)が実在する場合のみ。
    //   ドキュメントが無いのにここへ来たのは状態不整合なので、誤誘導せず
    //   ヒアリングからやり直す（状態を active に戻し、次送信でケース1が走る）。
    // ===================================================================
    const designDoc = await prisma.document.findFirst({
      where: { projectId, type: { in: ["sprint", "requirements"] } },
      select: { id: true },
    });
    if (!designDoc) {
      console.warn(
        `[ORCHESTRATOR] ケース4 到達だがドキュメント無し（status=${status}）→ ヒアリングへ復帰`,
      );
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: "active", debateContext: undefined },
      });
      send({
        type: "text",
        data: {
          agent: "orchestrator",
          chunk:
            "セッションを初期化しました。もう一度、依頼内容を送信してください。Orchestratorがヒアリングを始めます。",
        },
      });
      send({ type: "done", data: { sessionId } });
      return;
    }
    send({
      type: "text",
      data: {
        agent: "orchestrator",
        chunk:
          "設計書が完成しています。「Claude Codeで実行」から実装を開始してください。",
      },
    });
    send({ type: "done", data: { sessionId } });
  });
}
