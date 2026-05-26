import { prisma } from "@/lib/prisma";
import { isNonEmptyString, isValidNewRepoName, MAX_TITLE_LENGTH } from "@/lib/validation";
import { isSystemId } from "@/lib/systems";
import { isBusinessCategory, type BusinessCategoryId } from "@/lib/categories";
import { ORG_ORDER, type OrgNameType } from "@/types/portfolio";

function isOrgName(value: unknown): value is OrgNameType {
  return typeof value === "string" && (ORG_ORDER as string[]).includes(value);
}

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      sessions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      },
      documents: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }
  const approvals = await prisma.approvalRequest.findMany({
    where: { sessionId: { in: project.sessions.map((s) => s.id) } },
    orderBy: { createdAt: "desc" },
  });
  const currentSessionStatus = project.sessions[0]?.status ?? "active";
  return Response.json({ project, approvals, currentSessionStatus });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const obj = body as Record<string, unknown>;
  const updateData: {
    title?: string;
    targetSystem?: string | null;
    targetLabel?: string | null;
    businessCategory?: BusinessCategoryId;
    orgName?: OrgNameType;
  } = {};

  if ("title" in obj) {
    const rawTitle = obj.title;
    if (!isNonEmptyString(rawTitle, MAX_TITLE_LENGTH)) {
      return Response.json(
        { error: "validation_failed", details: [{ field: "title", message: `titleは最大${MAX_TITLE_LENGTH}文字` }] },
        { status: 400 },
      );
    }
    updateData.title = (rawTitle as string).trim();
  }

  if ("targetSystem" in obj) {
    const ts = obj.targetSystem;
    if (ts === null) {
      updateData.targetSystem = null;
    } else if (typeof ts === "string" && ts.length > 0 && (isSystemId(ts) || isValidNewRepoName(ts))) {
      updateData.targetSystem = ts;
    } else {
      return Response.json({ error: "invalid_targetSystem" }, { status: 400 });
    }
  }

  if ("targetLabel" in obj) {
    const tl = obj.targetLabel;
    if (tl === null) {
      updateData.targetLabel = null;
    } else if (typeof tl === "string") {
      updateData.targetLabel = tl.slice(0, 100).trim();
    }
  }

  if ("businessCategory" in obj) {
    const bc = obj.businessCategory;
    if (!isBusinessCategory(bc)) {
      return Response.json({ error: "invalid_businessCategory" }, { status: 400 });
    }
    updateData.businessCategory = bc;
  }

  if ("orgName" in obj) {
    const on = obj.orgName;
    if (!isOrgName(on)) {
      return Response.json({ error: "invalid_orgName" }, { status: 400 });
    }
    updateData.orgName = on;
  }

  if (Object.keys(updateData).length === 0) {
    return Response.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }

  const updated = await prisma.project.update({
    where: { id },
    data: updateData,
    select: {
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
      orgName: true,
      updatedAt: true,
    },
  });

  return Response.json({ project: updated });
}

// アーカイブ（ソフトデリート）。
// ハードデリートは関連レコード（Document 等）が多く cascade のリスクがあるため行わない。
// archivedAt = now() を入れるだけで UI 一覧（GET /api/projects は archivedAt IS NULL で絞る）
// から消える。DB 上はデータが残るため後から復元可能。
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const existing = await prisma.project.findUnique({
    where: { id },
    select: { id: true, archivedAt: true },
  });
  if (!existing) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }

  // 既にアーカイブ済みでも冪等に 204 を返す
  if (!existing.archivedAt) {
    await prisma.project.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  return new Response(null, { status: 204 });
}
