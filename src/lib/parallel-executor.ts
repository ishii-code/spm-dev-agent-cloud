import { prisma } from "./prisma";
import { runClaudeCode } from "./claude-code-runner";
import {
  notifyThread,
  postSlackThread,
  waitForReactionApproval,
} from "./slack-notifier";

export interface DevPart {
  partNumber: number;
  title: string;
  prompt: string;
  dependsOn?: number[];
}

const SPLIT_MAX_RETRIES = 3;
const SPLIT_DOC_PREVIEW_CHARS = 3000;
const SPLIT_MAX_COMPLETION_TOKENS = 1500;

export class SplitIntoPartsError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = "SplitIntoPartsError";
  }
}

interface RawSplitPart {
  id?: number;
  partNumber?: number;
  title?: string;
  description?: string;
  prompt?: string;
  dependsOn?: number[];
}

interface RawSplitResponse {
  parts?: RawSplitPart[];
}

async function callOpenAiForSplit(
  designDocument: string,
  projectTitle: string,
): Promise<string> {
  const { openai, OPENAI_MODEL, hasOpenAiKey } = await import("./openai");
  if (!hasOpenAiKey()) {
    throw new SplitIntoPartsError(
      "OPENAI_API_KEY が未設定のため splitIntoParts を実行できません",
      "no_api_key",
    );
  }
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: SPLIT_MAX_COMPLETION_TOKENS,
    messages: [
      {
        role: "system",
        content:
          `設計書を3〜5つのパートに分割してJSON形式のみで返してください。\n` +
          `必ず以下の形式で返答（前後に説明文を付けない）：\n` +
          `{"parts":[{"id":1,"title":"DBスキーマ","description":"説明","dependsOn":[]},{"id":2,"title":"API層","description":"説明","dependsOn":[1]}]}`,
      },
      {
        role: "user",
        content: `プロジェクト：${projectTitle}\n\n設計書：\n${designDocument.slice(0, SPLIT_DOC_PREVIEW_CHARS)}`,
      },
    ],
    // 注意: response_format: { type: 'json_object' } は gpt-5.5 で空応答を引き起こすため使わない。
  });
  return response.choices[0]?.message?.content ?? "";
}

function parseSplitResponse(text: string): DevPart[] {
  if (!text.trim()) {
    throw new SplitIntoPartsError("OpenAI 応答が空文字列でした", "empty_response");
  }

  const match = text.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : text;

  let parsed: RawSplitResponse;
  try {
    parsed = JSON.parse(jsonStr) as RawSplitResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SplitIntoPartsError(
      `JSONパース失敗: ${msg} / raw先頭: ${jsonStr.slice(0, 200)}`,
      "parse_failed",
    );
  }

  const rawParts = parsed?.parts;
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    throw new SplitIntoPartsError(
      `parts が配列でない、または空（型=${typeof parsed?.parts}, length=${Array.isArray(rawParts) ? rawParts.length : "n/a"}）`,
      "no_parts",
    );
  }

  const parts: DevPart[] = rawParts.map((p, i) => ({
    partNumber: p.partNumber ?? p.id ?? i + 1,
    title: p.title ?? `Part ${i + 1}`,
    prompt: p.prompt ?? p.description ?? "",
    dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [],
  }));

  const invalid = parts.find((p) => !p.prompt.trim());
  if (invalid) {
    throw new SplitIntoPartsError(
      `Part${invalid.partNumber}: prompt/description が空`,
      "empty_prompt",
    );
  }

  return parts;
}

export async function splitIntoParts(
  designDocument: string,
  projectTitle: string,
): Promise<DevPart[]> {
  console.log("[SPLIT] start", {
    docLength: designDocument.length,
    projectTitle,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SPLIT_MAX_RETRIES; attempt++) {
    console.log(`[SPLIT] attempt ${attempt}/${SPLIT_MAX_RETRIES}`);
    try {
      const text = await callOpenAiForSplit(designDocument, projectTitle);
      console.log(
        `[SPLIT] raw (${text.length} chars):`,
        text.slice(0, 300).replace(/\s+/g, " "),
      );
      const parts = parseSplitResponse(text);
      console.log(`[SPLIT] success: ${parts.length} parts`);
      return parts;
    } catch (e) {
      lastError = e;
      const stage = e instanceof SplitIntoPartsError ? e.stage : "openai_call";
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[SPLIT] attempt ${attempt} failed [${stage}]: ${msg}`);
      // OPENAI_API_KEY 未設定はリトライ不要
      if (e instanceof SplitIntoPartsError && e.stage === "no_api_key") {
        throw e;
      }
    }
  }

  const finalMsg =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new SplitIntoPartsError(
    `${SPLIT_MAX_RETRIES}回リトライしても成功せず。最後のエラー: ${finalMsg}`,
    "max_retries_exceeded",
  );
}

function getExecutionWaves(parts: DevPart[]): DevPart[][] {
  const waves: DevPart[][] = [];
  const remaining = [...parts];
  while (remaining.length > 0) {
    const completedNums = waves.flat().map((p) => p.partNumber);
    const executable = remaining.filter((p) =>
      (p.dependsOn ?? []).every((dep) => completedNums.includes(dep)),
    );
    if (executable.length === 0) break;
    waves.push(executable);
    executable.forEach((p) => {
      const idx = remaining.findIndex((r) => r.partNumber === p.partNumber);
      if (idx >= 0) remaining.splice(idx, 1);
    });
  }
  return waves;
}

export async function runParallelWaterfall(
  projectId: string,
  projectTitle: string,
  parts: DevPart[],
  workingDir: string,
  slackThreadTs: string | undefined,
  onOutput: (partNumber: number, line: string) => void,
  onPartStatus?: (
    partNumber: number,
    status: "running" | "success" | "error" | "skipped",
  ) => void,
): Promise<{ success: boolean; results: Record<number, boolean> }> {
  const results: Record<number, boolean> = {};
  const waves = getExecutionWaves(parts);

  for (const wave of waves) {
    await Promise.all(
      wave.map(async (part) => {
        const partLabel = `${projectTitle} - Part${part.partNumber}: ${part.title}`;

        // ⓪ 既に completed / skipped の場合は実行をスキップ
        const existing = await prisma.document
          .findFirst({
            where: { projectId, partNumber: part.partNumber, type: "sprint_part" },
            select: { executionStatus: true },
          })
          .catch(() => null);
        if (existing?.executionStatus === "completed") {
          console.log(`[PARALLEL] Part${part.partNumber}は完了済み。スキップ`);
          onOutput(
            part.partNumber,
            `✅ Part${part.partNumber}: ${part.title} は既に完了済みのためスキップします`,
          );
          onPartStatus?.(part.partNumber, "success");
          results[part.partNumber] = true;
          return;
        }
        if (existing?.executionStatus === "skipped") {
          console.log(`[PARALLEL] Part${part.partNumber}はスキップ済み`);
          onOutput(
            part.partNumber,
            `⏭️ Part${part.partNumber}: ${part.title} は既にスキップ済みです`,
          );
          onPartStatus?.(part.partNumber, "skipped");
          results[part.partNumber] = false;
          return;
        }

        // ① Slackで実行前承認を取る
        const approvalText =
          `🔧 *【${partLabel}】実行前確認*\n\n` +
          `内容：${part.prompt.slice(0, 200)}${part.prompt.length > 200 ? "..." : ""}\n\n` +
          `✅ で承認 / ❌ でスキップ`;
        const approvalTs = slackThreadTs
          ? await postSlackThread(slackThreadTs, approvalText)
          : "";
        const approval = approvalTs
          ? await waitForReactionApproval(approvalTs, slackThreadTs)
          : ("approved" as const);

        if (approval !== "approved") {
          if (slackThreadTs) {
            await postSlackThread(slackThreadTs, `⏭️ *【${partLabel}】スキップされました*`);
          }
          onOutput(part.partNumber, `⏭️ Part${part.partNumber}: ${part.title} スキップ`);
          onPartStatus?.(part.partNumber, "skipped");
          results[part.partNumber] = false;
          return;
        }

        // ② 承認OK → 実行開始
        if (slackThreadTs) {
          await postSlackThread(slackThreadTs, `✅ *【${partLabel}】承認・実行開始*`);
        }
        onPartStatus?.(part.partNumber, "running");
        onOutput(part.partNumber, `=== Part${part.partNumber}: ${part.title} 開始 ===`);

        try {
          const result = await runClaudeCode(
            part.prompt,
            workingDir,
            partLabel,
            projectId,
            slackThreadTs,
            (line) => onOutput(part.partNumber, `[Part${part.partNumber}] ${line}`),
          );

          if (!result.success) {
            throw new Error(
              result.exitCode != null
                ? `Claude Code終了コード: ${result.exitCode}`
                : "Claude Code実行失敗",
            );
          }

          if (slackThreadTs) {
            await postSlackThread(slackThreadTs, `✅ *【${partLabel}】完了*`);
          } else {
            await notifyThread(projectId, `✅ *【${partLabel}】完了*`);
          }

          await prisma.document
            .updateMany({
              where: { projectId, partNumber: part.partNumber, type: "sprint_part" },
              data: { executionStatus: "completed", executedAt: new Date() },
            })
            .catch((dbErr) => {
              console.error(`[PARALLEL] Part${part.partNumber} DB更新エラー:`, dbErr);
            });

          results[part.partNumber] = true;
          onPartStatus?.(part.partNumber, "success");
        } catch (e) {
          console.error(`[PARALLEL] Part${part.partNumber} エラー:`, e);

          const errText = e instanceof Error ? e.message : String(e);
          if (slackThreadTs) {
            await postSlackThread(
              slackThreadTs,
              `❌ *【${partLabel}】エラー: ${errText.slice(0, 200)}*`,
            ).catch(() => {});
          } else {
            await notifyThread(
              projectId,
              `❌ *【${partLabel}】エラー: ${errText.slice(0, 200)}*`,
            ).catch(() => {});
          }

          await prisma.document
            .updateMany({
              where: { projectId, partNumber: part.partNumber, type: "sprint_part" },
              data: { executionStatus: "error", executedAt: new Date() },
            })
            .catch((dbErr) => {
              console.error(`[PARALLEL] Part${part.partNumber} DB更新エラー:`, dbErr);
            });

          results[part.partNumber] = false;
          onPartStatus?.(part.partNumber, "error");
        }
      }),
    );
  }

  const overallSuccess = Object.values(results).every(Boolean);
  await notifyThread(
    projectId,
    overallSuccess
      ? `🎉 *【${projectTitle}】全パート完了*`
      : `⚠️ *【${projectTitle}】一部パートでエラーが発生しました*`,
  );

  return {
    success: overallSuccess,
    results,
  };
}

export { getExecutionWaves };
