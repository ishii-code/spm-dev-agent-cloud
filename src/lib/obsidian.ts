import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatJstDate } from "./time";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ?? "";

export const SYSTEM_PATHS: Record<string, string> = {
  "spm-project-2": path.join(os.homedir(), "spm-project-2", "src"),
  "spm-diagnosis": path.join(os.homedir(), "spm-diagnosis", "src"),
  "peco-stock": path.join(os.homedir(), "peco-stock", "src"),
  "peco-property": path.join(os.homedir(), "peco-property", "src"),
  "spm-dev-agent": path.join(os.homedir(), "spm-dev-agent", "src"),
};

const SYSTEM_CODE_LIMIT = 50_000;
const SYSTEM_CODE_MAX_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "generated"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readSystemCode(targetSystem: string): Promise<string> {
  const basePath = SYSTEM_PATHS[targetSystem];
  if (!basePath) return "";

  const parts: string[] = [];
  let totalSize = 0;

  const append = (header: string, content: string) => {
    if (totalSize >= SYSTEM_CODE_LIMIT) return;
    const remaining = SYSTEM_CODE_LIMIT - totalSize;
    const trimmed =
      content.length > remaining ? `${content.slice(0, remaining)}\n// ...（${content.length - remaining}文字省略）` : content;
    const block = `\n\n// === ${header} ===\n${trimmed}`;
    parts.push(block);
    totalSize += block.length;
  };

  // 重要ファイル先読み: prisma/schema.prisma
  const projectRoot = path.dirname(basePath); // basePath は .../src なので親が repo root
  const schemaPath = path.join(projectRoot, "prisma", "schema.prisma");
  if (await pathExists(schemaPath)) {
    try {
      const schema = await fs.readFile(schemaPath, "utf-8");
      append(path.relative(projectRoot, schemaPath), schema);
    } catch {
      // skip
    }
  }

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > SYSTEM_CODE_MAX_DEPTH) return;
    if (totalSize >= SYSTEM_CODE_LIMIT) return;
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    // 優先順: api → lib → types → 残り
    const priorityOrder = (name: string) =>
      name === "api" ? 0 : name === "lib" ? 1 : name === "types" ? 2 : 3;
    entries.sort((a, b) => priorityOrder(a.name) - priorityOrder(b.name));

    for (const entry of entries) {
      if (totalSize >= SYSTEM_CODE_LIMIT) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (/\.(ts|tsx|prisma)$/.test(entry.name)) {
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          append(path.relative(projectRoot, fullPath), content);
        } catch {
          // skip unreadable
        }
      }
    }
  }

  await walk(basePath, 0);
  return parts.join("");
}

if (!VAULT_PATH) {
  console.warn("[obsidian] OBSIDIAN_VAULT_PATH is not set");
}

const CONTEXT_FILES = [
  "SPM/Vision/SPM_Vision_v5.md",
  "SPM/00_SPM2030_インデックス.md",
  "AIエージェント/開発エージェントシステム設計書.md",
] as const;

export interface SpmContext {
  vision: string;
  index: string;
  agentDesign: string;
  combined: string;
}

async function readVaultFile(relativePath: string): Promise<string> {
  // VAULT_PATH 未設定 or 読み込み失敗時は「[読み込み失敗]」をモデル context に注入しない。
  // 接地は platform-facts.ts（コード同梱）が担保するため、欠損は空文字で無害化する。
  if (!VAULT_PATH) return "";
  const absolute = path.join(VAULT_PATH, relativePath);
  try {
    return await fs.readFile(absolute, "utf-8");
  } catch {
    return "";
  }
}

export async function loadSpmContext(): Promise<SpmContext> {
  const [vision, index, agentDesign] = await Promise.all(
    CONTEXT_FILES.map(readVaultFile),
  );

  const combined = [
    "## SPM Vision v5",
    vision,
    "",
    "## SPM 全体インデックス",
    index,
    "",
    "## AI開発エージェントシステム設計書",
    agentDesign,
  ].join("\n");

  return { vision, index, agentDesign, combined };
}

export async function writeVaultFile(
  relativePath: string,
  content: string,
): Promise<string> {
  const absolute = path.join(VAULT_PATH, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf-8");
  return absolute;
}

export function projectFolderName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

export interface ProjectPathInfo {
  title: string;
  projectType: string; // "existing" | "new"
  targetLabel: string | null;
}

export function projectDocPath(
  project: ProjectPathInfo,
  filename: string,
): string {
  const safeTitle = projectFolderName(project.title);
  if (project.projectType === "new") {
    return path.join("開発プロジェクト", "新規", safeTitle, filename);
  }
  const labelDir = project.targetLabel
    ? projectFolderName(project.targetLabel)
    : "未分類";
  return path.join("開発プロジェクト", labelDir, safeTitle, filename);
}

export async function saveSkillDocument(
  skillName: string,
  content: string,
): Promise<void> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return;

  const skillDir = path.join(vaultPath, "SPM", "スキル");
  await fs.mkdir(skillDir, { recursive: true });

  const fileName = skillName.replace(/[/\\:*?"<>|]/g, "_") + ".md";
  const filePath = path.join(skillDir, fileName);
  await fs.writeFile(filePath, content, "utf-8");

  const indexPath = path.join(skillDir, "00_スキルインデックス.md");
  const date = formatJstDate();
  const newEntry = `| [[${skillName}]] | ${date} | 自動生成 |\n`;

  try {
    const existing = await fs.readFile(indexPath, "utf-8");
    if (!existing.includes(skillName)) {
      const updated = existing + newEntry;
      await fs.writeFile(indexPath, updated, "utf-8");
    }
  } catch {
    // インデックスが無ければ何もしない（初回はスキル本体のみ作成）
  }
}

export async function generateSkillSummary(
  projectTitle: string,
  executionOutput: string,
): Promise<{ name: string; content: string } | null> {
  try {
    const { openai, OPENAI_MODEL } = await import("./openai");
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `SPM開発エージェントです。実装内容から新しいスキルドキュメントを生成してください。
新しい技術・解決策・パターンがあった場合のみ生成してください。
なければ {"name": null, "content": null} を返してください。
JSON形式で返答：{"name": "スキル名（日本語）", "content": "Markdown形式のスキル文書"}

スキル文書のフォーマット：
# ✅ [スキル名]
習得日：[今日の日付] | カテゴリ：[カテゴリ]
## 概要
## ポイント
## 関連ファイル`,
        },
        {
          role: "user",
          content: `プロジェクト：${projectTitle}\n\n実装内容：\n${executionOutput.substring(0, 2000)}`,
        },
      ],
    });

    const result = JSON.parse(response.choices[0]?.message?.content ?? "{}") as {
      name?: string | null;
      content?: string | null;
    };
    if (!result.name || !result.content) return null;
    return { name: result.name, content: result.content };
  } catch {
    return null;
  }
}
