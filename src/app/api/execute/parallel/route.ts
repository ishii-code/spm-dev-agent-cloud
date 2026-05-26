import { spawn } from "child_process";
import { promises as fsPromises } from "fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createSSEStream } from "@/lib/sse";
import { isAllowedRepo, repoPath, type RepoId } from "@/lib/repos";
import { isNonEmptyString, isValidNewRepoName } from "@/lib/validation";
import {
  notifyExecutionStart,
  notifyThread,
  postSlackThread,
} from "@/lib/slack-notifier";
import { splitIntoParts, type DevPart } from "@/lib/parallel-executor";
import { fireAndForgetTick } from "@/lib/parallel-tick";

const CODE_PATH = "/usr/local/bin/code";

export const runtime = "nodejs";

interface Body {
  documentId: string;
  projectId: string;
  targetRepo: string;
}

function validate(body: unknown):
  | { ok: true; value: Body }
  | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const obj = body as Record<string, unknown>;
  if (!isNonEmptyString(obj.documentId, 100)) {
    return { ok: false, status: 400, error: "documentId_required" };
  }
  if (!isNonEmptyString(obj.projectId, 100)) {
    return { ok: false, status: 400, error: "projectId_required" };
  }
  const repo = obj.targetRepo;
  if (typeof repo !== "string" || (!isAllowedRepo(repo) && !isValidNewRepoName(repo))) {
    return { ok: false, status: 400, error: "invalid_targetRepo" };
  }
  return {
    ok: true,
    value: {
      documentId: obj.documentId,
      projectId: obj.projectId,
      targetRepo: repo,
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
  const { documentId, projectId, targetRepo } = validated.value;

  const [document, project] = await Promise.all([
    prisma.document.findUnique({ where: { id: documentId } }),
    prisma.project.findUnique({ where: { id: projectId } }),
  ]);
  if (!document) return Response.json({ error: "document_not_found" }, { status: 404 });
  if (!project) return Response.json({ error: "project_not_found" }, { status: 404 });
  if (document.projectId !== projectId) {
    return Response.json({ error: "project_mismatch" }, { status: 409 });
  }
  if (document.type !== "sprint") {
    return Response.json({ error: "not_a_sprint_document" }, { status: 409 });
  }

  const isNewProject = project.projectType === "new";
  if (!isNewProject && !isAllowedRepo(targetRepo)) {
    return Response.json({ error: "invalid_targetRepo" }, { status: 400 });
  }

  const cwd = isAllowedRepo(targetRepo)
    ? repoPath(targetRepo as RepoId)
    : path.join(os.homedir(), targetRepo);

  const startTime = Date.now();
  const newThreadTs = await notifyExecutionStart(
    projectId,
    `${project.title}（並列実行）`,
    targetRepo,
    startTime,
  );
  const threadTs = newThreadTs ?? project.slackThreadTs ?? undefined;

  return createSSEStream(async (send) => {
    if (isNewProject) {
      let dirExists = false;
      try {
        await fsPromises.access(cwd);
        dirExists = true;
      } catch {
        dirExists = false;
      }
      if (!dirExists) {
        send({
          type: "execute_log",
          data: { line: `新規リポジトリを作成中: ${cwd}\n` },
        });
        await fsPromises.mkdir(cwd, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(
            "npx",
            [
              "create-next-app@latest", ".",
              "--typescript", "--tailwind", "--eslint", "--app",
              "--src-dir", "--import-alias", "@/*",
              "--use-npm", "--yes",
            ],
            {
              cwd,
              env: {
                ...process.env,
                PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          proc.stdout?.on("data", (d: Buffer) => {
            send({ type: "execute_log", data: { line: d.toString() } });
          });
          proc.stderr?.on("data", (d: Buffer) => {
            send({ type: "execute_log", data: { line: d.toString() } });
          });
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`create-next-app failed: exit ${code}`));
          });
          proc.on("error", reject);
        });
      }
    }

    spawn(CODE_PATH, [cwd], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    }).unref();
    notifyThread(projectId, "🖥️ VS Codeを起動しました（並列実行）").catch(() => {});

    // 既存パートがあれば再利用（GPT再分割しない）
    const existingParts = await prisma.document.findMany({
      where: {
        projectId,
        partNumber: { not: null },
        type: "sprint_part",
      },
      orderBy: { partNumber: "asc" },
    });

    let parts: DevPart[];
    const partDocIds: Record<number, string> = {};

    if (existingParts.length > 0) {
      console.log(`[PARALLEL] 既存の${existingParts.length}パートを再利用`);
      send({
        type: "execute_log",
        data: { line: `♻️ 既存の${existingParts.length}パートを再利用します（GPT再分割スキップ）\n` },
      });
      parts = existingParts
        .filter((d) => d.partNumber != null)
        .map<DevPart>((d) => ({
          partNumber: d.partNumber!,
          title: d.partTitle ?? `Part${d.partNumber}`,
          prompt: d.content,
          dependsOn: [],
        }));
      for (const d of existingParts) {
        if (d.partNumber == null) continue;
        partDocIds[d.partNumber] = d.id;
        const raw = d.executionStatus ?? "waiting";
        const uiStatus =
          raw === "completed"
            ? "success"
            : raw === "executing"
              ? "running"
              : raw === "error"
                ? "error"
                : raw === "skipped"
                  ? "skipped"
                  : "pending";
        send({
          type: "parallel_part_status",
          data: {
            partNumber: d.partNumber,
            title: d.partTitle ?? `Part${d.partNumber}`,
            status: uiStatus,
          },
        });
      }
    } else {
      console.log("[PARALLEL] 新規にsplitIntoParts実行");
      send({
        type: "execute_log",
        data: { line: "📊 設計書をパートに分割中（GPT判断）...\n" },
      });

      const splitResult = await splitIntoParts(document.content, project.title)
        .then((p) => ({ ok: true as const, parts: p }))
        .catch((err: unknown) => ({ ok: false as const, error: err }));

      if (!splitResult.ok || splitResult.parts.length === 0) {
        const detail = !splitResult.ok
          ? `splitIntoParts失敗: ${
              splitResult.error instanceof Error
                ? splitResult.error.message
                : String(splitResult.error)
            }`.slice(0, 300)
          : "splitIntoParts が空配列を返しました（GPT応答が不正）";
        console.error("[PARALLEL]", detail);

        // Slack にエラー通知（threadTs があれば）
        if (threadTs) {
          await postSlackThread(
            threadTs,
            `❌ 並列実行を開始できませんでした\n${detail}\n\n設計書の内容を確認するか、通常実行をお試しください。`,
          ).catch(() => {});
        }

        // 「実行中」状態にしない・ロックも残さない
        await prisma.project
          .update({
            where: { id: projectId },
            data: {
              parallelStatus: null,
              parallelRunId: null,
              parallelWorkingDir: null,
            },
          })
          .catch(() => {});
        await prisma.session
          .updateMany({ where: { projectId }, data: { status: "active" } })
          .catch(() => {});

        send({ type: "execute_log", data: { line: `❌ ${detail}\n` } });
        send({ type: "error", data: { message: detail } });
        send({
          type: "execute_done",
          data: { success: false, exitCode: null, documentId, results: {} },
        });
        send({ type: "done", data: { documentId } });
        return;
      }

      parts = splitResult.parts;
      send({
        type: "execute_log",
        data: { line: `🔀 ${parts.length}パートに分割しました\n` },
      });
      for (const part of parts) {
        const created = await prisma.document.create({
          data: {
            projectId,
            type: "sprint_part",
            title: `Part${part.partNumber}: ${part.title}`,
            content: part.prompt,
            partNumber: part.partNumber,
            partTitle: part.title,
            executionStatus: "waiting",
            dependsOn: (part.dependsOn ?? []) as unknown as object,
          },
        });
        partDocIds[part.partNumber] = created.id;
        send({
          type: "parallel_part_status",
          data: { partNumber: part.partNumber, title: part.title, status: "pending" },
        });
      }
    }

    await prisma.session
      .updateMany({
        where: { projectId },
        data: { status: "executing" },
      })
      .catch(() => {});
    await prisma.project
      .update({
        where: { id: projectId },
        data: {
          isParallel: true,
          parallelStatus: "running",
          parallelWorkingDir: cwd,
          parallelRunId: null,
          parallelDoneNotifiedAt: null,
        },
      })
      .catch(() => {});

    // tick 駆動に切り替え：fire-and-forget で最初の tick をキック。
    // 残りの進捗は client が /api/projects/[id]/parts と
    // /api/projects/[id]/logs をポーリングして取得する。
    fireAndForgetTick(projectId);

    await prisma.document.update({
      where: { id: documentId },
      data: { executedAt: new Date() },
    });

    send({
      type: "execute_log",
      data: { line: "🚀 並列実行を開始しました。進捗はパート一覧をご確認ください。\n" },
    });
    send({
      type: "execute_done",
      data: {
        success: true,
        exitCode: null,
        documentId,
        // tick 駆動では実行は非同期。結果は parts ポーリングで取得。
        results: {},
      },
    });
    send({ type: "done", data: { documentId } });
  });
}
