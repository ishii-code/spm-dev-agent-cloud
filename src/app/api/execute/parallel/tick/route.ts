import { prisma } from "@/lib/prisma";
import { isNonEmptyString } from "@/lib/validation";
import { fireAndForgetTick, processOneTick } from "@/lib/parallel-tick";

export const runtime = "nodejs";

interface Body {
  projectId: string;
  // true なら同期実行（テスト用）。デフォルトは fire-and-forget。
  blocking?: boolean;
}

function validate(body: unknown):
  | { ok: true; value: Body }
  | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const obj = body as Record<string, unknown>;
  if (!isNonEmptyString(obj.projectId, 100)) {
    return { ok: false, status: 400, error: "projectId_required" };
  }
  return {
    ok: true,
    value: {
      projectId: obj.projectId,
      blocking: obj.blocking === true,
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const validated = validate(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: validated.status });
  }
  const { projectId, blocking } = validated.value;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, parallelStatus: true },
  });
  if (!project) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }
  if (project.parallelStatus !== "running") {
    return Response.json({ status: "not_running" });
  }

  if (blocking) {
    const result = await processOneTick(projectId);
    return Response.json(result);
  }

  fireAndForgetTick(projectId);
  return Response.json({ status: "kicked" });
}
