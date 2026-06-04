import { prisma } from "@/lib/prisma";
import { validateProjectInput } from "@/lib/validation";
import { getSystem } from "@/lib/systems";
import { performStartupRecovery } from "@/lib/startup";
import { requireApiAuth, SESSION_COOKIE } from "@/lib/auth";
import {
  hasServiceKeyHeader,
  serviceAuthErrorResponse,
  verifyServiceKey,
} from "@/lib/api-auth";
import { generateInitialInterview } from "@/lib/agents/debate";
import { readSystemCode } from "@/lib/obsidian";
import { buildUnreadableUrlNotice, buildUrlGuardForModel } from "@/lib/url-detect";

export const runtime = "nodejs";

let startupDone = false;
async function ensureStartup(): Promise<void> {
  if (startupDone) return;
  startupDone = true;
  try {
    await performStartupRecovery();
  } catch (e) {
    startupDone = false;
    console.error("[STARTUP] performStartupRecovery エラー:", e);
  }
}

const PROJECT_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  projectType: true,
  targetSystem: true,
  targetLabel: true,
  skipRequirements: true,
  isParallel: true,
  businessCategory: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  await ensureStartup();
  const rows = await prisma.project.findMany({
    where: { archivedAt: null }, // アーカイブ済みは一覧から除外（ソフトデリート）
    orderBy: { updatedAt: "desc" },
    select: {
      ...PROJECT_SELECT,
      sessions: {
        select: { id: true, status: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });
  const projects = rows.map((p) => {
    const sessionStatus = p.sessions[0]?.status ?? "initial_interview";
    return {
      ...p,
      sessionStatus,
      isExecuting: sessionStatus === "executing",
    };
  });
  return Response.json({ projects });
}

export async function POST(request: Request) {
  // 認証：X-Service-Key（外部サービス）OR セッション cookie（ブラウザ）のどちらか一方が通れば OK。
  const hasKey = hasServiceKeyHeader(request);
  const hasSessionCookie =
    request.headers.get("cookie")?.includes(`${SESSION_COOKIE}=`) ?? false;
  console.log(
    `[PROJECTS_API] POST 受信 hasServiceKey=${hasKey} hasSessionCookie=${hasSessionCookie}`,
  );

  let authed = false;
  let authReason = "none";
  // セッション作成時のみ owner を設定（service-key 経路は null＝レガシー開放のまま）。
  let ownerUserId: number | null = null;
  if (hasKey) {
    const svc = verifyServiceKey(request);
    if (svc.ok) {
      authed = true;
      authReason = "service_key";
    } else if (svc.reason === "server_misconfigured") {
      // サーバ側に SERVICE_API_KEY 未設定。フォールバックで隠さず 500 を返す。
      console.error(`[PROJECTS_API] 認証結果 reason=service_key_${svc.reason}`);
      return serviceAuthErrorResponse(svc.reason);
    } else {
      // X-Service-Key が無効（不一致）でも、セッション cookie があればフォールバック。
      authReason = `service_key_${svc.reason}`;
      const sessionAuth = await requireApiAuth();
      if (sessionAuth.ok) {
        authed = true;
        authReason = "session_fallback";
        ownerUserId = sessionAuth.session.userId;
      }
    }
  } else {
    const sessionAuth = await requireApiAuth();
    if (sessionAuth.ok) {
      authed = true;
      authReason = "session";
      ownerUserId = sessionAuth.session.userId;
    } else {
      authReason = "session_missing";
    }
  }

  console.log(`[PROJECTS_API] 認証結果 reason=${authReason} ok=${authed}`);
  if (!authed) {
    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    console.warn(`[PROJECTS_API] 失敗時 401 reason=${authReason} ip=${ip}`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const result = validateProjectInput(body);
  if (!result.ok) {
    console.warn(
      "[POST /api/projects] validation_failed:",
      JSON.stringify(result.errors),
    );
    return Response.json(
      { error: "validation_failed", details: result.errors },
      { status: 400 },
    );
  }
  console.log(
    "[POST /api/projects] accepted:",
    JSON.stringify({
      title: result.value.title.slice(0, 80),
      projectType: result.value.projectType,
      targetSystem: result.value.targetSystem,
      businessCategory: result.value.businessCategory,
    }),
  );

  // targetLabel が空ならシステム定義から自動補完
  let targetLabel = result.value.targetLabel;
  if (result.value.projectType === "existing" && !targetLabel && result.value.targetSystem) {
    const sys = getSystem(result.value.targetSystem);
    targetLabel = sys?.shortLabel ?? null;
  }
  // 新規アプリはリポジトリ名をそのままラベルにする
  if (result.value.projectType === "new" && !targetLabel && result.value.targetSystem) {
    targetLabel = result.value.targetSystem;
  }

  // 作成者の Slack User ID（任意）。設定されていれば承認通知を本人 DM に送る。
  // validateProjectInput の対象外なので raw body から安全に取り出す。
  const rawBody =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const creatorSlackId =
    typeof rawBody.creatorSlackId === "string" && rawBody.creatorSlackId.trim().length > 0
      ? rawBody.creatorSlackId.trim()
      : null;

  const project = await prisma.project.create({
    data: {
      title: result.value.title,
      description: result.value.description,
      projectType: result.value.projectType,
      targetSystem: result.value.targetSystem,
      targetLabel,
      skipRequirements: result.value.skipRequirements,
      businessCategory: result.value.businessCategory,
      creatorSlackId,
      ownerId: ownerUserId, // セッション作成者を owner に。service-key 経路は null（レガシー開放）
      sessions: { create: {} },
    },
    include: {
      sessions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  // firstMessage（任意）：Work Monitor 等が組み立てた詳細プロンプト。指定があれば
  // プロジェクト画面を開く前に Orchestrator 議論を自動開始する。内部 /api/chat を
  // 呼び、SSE を最後まで drain して Orchestrator 応答の DB 保存完了を保証してから返す
  // （Cloud Run はレスポンス後にバックグラウンド処理が凍結され得るため同期実行する）。
  const firstMessage =
    typeof rawBody.firstMessage === "string" && rawBody.firstMessage.trim().length > 0
      ? rawBody.firstMessage.trim().slice(0, 10000)
      : null;
  if (firstMessage) {
    const sessionId = project.sessions[0]?.id;
    if (sessionId) {
      try {
        // Cloud Run はコンテナ内から自分の公開 URL への self-fetch が失敗する
        // （旧実装の fetch(origin/api/chat) は "fetch failed" になっていた）ため、
        // /api/chat のケース1（初回ヒアリング）相当をプロセス内で直接実行する。
        console.log(
          `[PROJECTS_API] firstMessage 指定あり → Orchestrator自動開始(in-process) projectId=${project.id} sessionId=${sessionId} len=${firstMessage.length}`,
        );
        // ユーザーの初回メッセージを保存
        await prisma.message.create({
          data: { sessionId, role: "user", content: firstMessage },
        });
        // URL 通知（chat route と同じ2段）：読めない URL があれば、理由バブルを
        // orchestrator Message として保存（SSE は無いので保存のみ＝UI 再読込で表示）。
        const urlNotice = buildUnreadableUrlNotice(firstMessage);
        if (urlNotice) {
          await prisma.message.create({
            data: {
              sessionId,
              role: "orchestrator",
              content: urlNotice,
              agentType: "orchestrator",
              metadata: { phase: "url_notice" },
            },
          });
        }
        // 既存コード概要（あれば）
        let systemCode = "";
        if (project.targetSystem) {
          try {
            systemCode = await readSystemCode(project.targetSystem);
          } catch {
            // ignore
          }
        }
        const targetLabelForChat = project.targetLabel ?? project.targetSystem ?? "";
        // URL ガードはモデル入力にだけ付与（保存済み user メッセージ・debateContext は元のまま）。
        const urlGuard = buildUrlGuardForModel(firstMessage);
        const interviewInput = urlGuard ? `${firstMessage}\n\n${urlGuard}` : firstMessage;
        // 初期ヒアリングを生成（SSE 不要なので onOutput は no-op）
        const interview = await generateInitialInterview(
          interviewInput,
          systemCode,
          targetLabelForChat,
          project.projectType,
          () => {},
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
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: "waiting_user",
            debateContext: {
              originalRequest: firstMessage,
              phase: "initial_interview",
              fullHistory: "",
            },
          },
        });
        console.log(
          `[PROJECTS_API] Orchestrator自動開始 完了 projectId=${project.id} interviewLen=${interview.length}`,
        );
      } catch (e) {
        // 失敗してもプロジェクト作成自体は成功として返す（ユーザーは画面で手動送信できる）。
        console.error(
          `[PROJECTS_API] firstMessage 自動処理失敗 projectId=${project.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  return Response.json({ project }, { status: 201 });
}
