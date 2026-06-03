import { spawn } from "child_process";
import { promises as fsPromises } from "fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createSSEStream } from "@/lib/sse";
import { runClaudeCode } from "@/lib/claude-code-runner";
import { extractImplementationPrompt } from "@/lib/agents/pm";
import { isAllowedRepo, repoPath, type RepoId } from "@/lib/repos";
import { checkSecurity } from "@/lib/security";
import { isNonEmptyString, isValidNewRepoName } from "@/lib/validation";
import {
  notifyExecutionStart,
  notifyThread,
  notifyComplete,
  waitForSlackApproval,
} from "@/lib/slack-notifier";
import { generateSkillSummary, saveSkillDocument } from "@/lib/obsidian";

const CODE_PATH = "/usr/local/bin/code";

export const runtime = "nodejs";

interface ExecuteBody {
  documentId: string;
  projectId: string;
  targetRepo: string;
  force: boolean;
}

function validate(body: unknown):
  | { ok: true; value: ExecuteBody }
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
      force: obj.force === true,
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
  const { documentId, projectId, targetRepo, force } = validated.value;

  const [document, project] = await Promise.all([
    prisma.document.findUnique({ where: { id: documentId } }),
    prisma.project.findUnique({ where: { id: projectId } }),
  ]);
  if (!document) {
    return Response.json({ error: "document_not_found" }, { status: 404 });
  }
  if (!project) {
    return Response.json({ error: "project_not_found" }, { status: 404 });
  }
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

  const prompt = extractImplementationPrompt(document.content);
  if (!prompt || prompt.trim().length === 0) {
    return Response.json({ error: "implementation_prompt_not_found" }, { status: 422 });
  }

  const cwd = isAllowedRepo(targetRepo)
    ? repoPath(targetRepo as RepoId)
    : path.join(os.homedir(), targetRepo);

  const security = checkSecurity(prompt);

  const startTime = Date.now();
  const newThreadTs = await notifyExecutionStart(
    projectId,
    project.title,
    targetRepo,
    startTime,
  );
  const threadTs = newThreadTs ?? project.slackThreadTs ?? undefined;

  return createSSEStream(async (send) => {
    if (!force) {
      const lineCount = document.content.split("\n").length;
      const sprintMatches = document.content.match(/Sprint\s*\d+/gi);
      const sprintCount = sprintMatches
        ? new Set(sprintMatches.map((m) => m.toLowerCase())).size
        : 0;
      const suggestParallel = lineCount > 150 || sprintCount >= 2;

      if (suggestParallel) {
        const latestSession = await prisma.session.findFirst({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (latestSession) {
          await prisma.session
            .update({
              where: { id: latestSession.id },
              data: { status: "waiting_parallel_confirm" },
            })
            .catch(() => {});
        }
        send({
          type: "parallel_suggestion",
          data: { lineCount, sprintCount, documentId, projectId, targetRepo },
        });
        send({ type: "done", data: { documentId } });
        return;
      }
    }

    // TODO(別issue): 並列(execute/parallel)と同じ FS 断絶あり — Cloud Run orchestrator の
    // /root に scaffold すると VM worker から不可視。#5 と同様に scaffold を VM worker へ
    // 移行する必要がある（newProjectPath + parallelStatus="scaffolding" 方式）。
    if (isNewProject) {
      let dirExists = false;
      try {
        await fsPromises.access(cwd);
        dirExists = true;
      } catch {
        dirExists = false;
      }

      if (!dirExists) {
        send({ type: "execute_log", data: { line: `新規リポジトリを作成中: ${cwd}\n` } });
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
            }
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
    notifyThread(projectId, "🖥️ VS Codeを起動しました").catch(() => {});

    if (security.requiresApproval) {
      send({
        type: "execute_log",
        data: {
          line: `⏳ Slack承認待ち中... スマホのSlackから ✅(承認) または ❌(却下) をリアクションしてください（1時間ごとにリマインド送信）\n`,
        },
      });

      const approvalDescription =
        `対象: ${targetRepo} / 種別: ${security.type ?? "security"} / ` +
        `キーワード: ${security.matchedKeywords.join(", ")}`;

      const approvalResult = await waitForSlackApproval(
        project.title,
        approvalDescription,
        threadTs,
        (elapsed) => {
          send({
            type: "execute_log",
            data: { line: `⏳ Slack承認待ち中... ${elapsed}秒経過\n` },
          });
        },
      );

      if (approvalResult === "rejected") {
        await notifyComplete(projectId, project.title, startTime, false);
        send({
          type: "execute_log",
          data: { line: `❌ 実装を中止しました（Slackで却下されました）\n` },
        });
        send({
          type: "error",
          data: { message: `実装を中止しました（Slackで却下されました）` },
        });
        send({
          type: "execute_done",
          data: { success: false, exitCode: null, documentId },
        });
        send({ type: "done", data: { documentId } });
        return;
      }

      send({
        type: "execute_log",
        data: { line: `✅ Slack承認済み。実装を続行します。\n` },
      });
    }

    send({
      type: "execute_log",
      data: { line: `$ cd ${cwd}\n$ claude -p '<prompt>' --no-color\n` },
    });

    const collected: string[] = [];
    let recentLines: string[] = [];
    const slackInterval = setInterval(() => {
      if (recentLines.length > 0) {
        const snippet = recentLines.splice(0).join("").slice(-800);
        notifyThread(projectId, `📝 実行中ログ:\n\`\`\`\n${snippet}\n\`\`\``).catch(() => {});
      }
    }, 30_000);

    // 実行中のログを 3 秒ごとに DB に書き戻し、/api/projects/[id]/logs から
    // ライブで参照できるようにする
    const liveLogInterval = setInterval(() => {
      if (collected.length === 0) return;
      const snapshot = collected.join("");
      prisma.document
        .update({
          where: { id: documentId },
          data: { executionLog: snapshot },
        })
        .catch(() => {});
    }, 3_000);

    await prisma.session
      .updateMany({ where: { projectId }, data: { status: "executing" } })
      .catch(() => {});
    await prisma.document
      .update({
        where: { id: documentId },
        data: { executionStatus: "executing" },
      })
      .catch(() => {});

    const result = await runClaudeCode(
      prompt,
      cwd,
      project.title,
      project.id,
      threadTs,
      (line) => {
        collected.push(line);
        recentLines.push(line);
        send({ type: "execute_log", data: { line } });
      },
    );

    clearInterval(slackInterval);
    clearInterval(liveLogInterval);
    await notifyComplete(projectId, project.title, startTime, result.success);

    await prisma.document.update({
      where: { id: documentId },
      data: {
        executionLog: collected.join(""),
        executedAt: new Date(),
        executionStatus: result.success ? "completed" : "error",
      },
    });
    await prisma.session
      .updateMany({
        where: { projectId },
        data: { status: result.success ? "completed" : "active" },
      })
      .catch(() => {});

    if (result.success && result.output.length > 100) {
      try {
        const skillSummary = await generateSkillSummary(project.title, result.output);
        if (skillSummary) {
          await saveSkillDocument(skillSummary.name, skillSummary.content);
          await notifyThread(
            project.id,
            `📚 スキルを自動記録しました: ${skillSummary.name}`,
          );
          send({
            type: "execute_log",
            data: { line: `📚 スキルを自動記録しました: ${skillSummary.name}\n` },
          });
        }
      } catch {
        // スキル生成失敗は実行成功扱いのまま無視
      }
    }

    send({
      type: "execute_done",
      data: {
        success: result.success,
        exitCode: result.exitCode,
        documentId,
      },
    });
    send({ type: "done", data: { documentId } });
  });
}
