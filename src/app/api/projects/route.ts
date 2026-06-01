import { prisma } from "@/lib/prisma";
import { validateProjectInput } from "@/lib/validation";
import { getSystem } from "@/lib/systems";
import { performStartupRecovery } from "@/lib/startup";
import { requireApiAuth } from "@/lib/auth";
import {
  hasServiceKeyHeader,
  serviceAuthErrorResponse,
  verifyServiceKey,
} from "@/lib/api-auth";

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
  if (hasServiceKeyHeader(request)) {
    const svc = verifyServiceKey(request);
    console.log(
      `[POST /api/projects] auth via X-Service-Key: ${svc.ok ? "ok" : "ng(" + svc.reason + ")"}`,
    );
    if (!svc.ok) return serviceAuthErrorResponse(svc.reason);
  } else {
    const sessionAuth = await requireApiAuth();
    console.log(
      `[POST /api/projects] auth via session cookie: ${sessionAuth.ok ? "ok" : "ng"}`,
    );
    if (!sessionAuth.ok) return sessionAuth.response;
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
      sessions: { create: {} },
    },
    include: {
      sessions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return Response.json({ project }, { status: 201 });
}
