import os from "node:os";
import path from "node:path";

export const ALLOWED_REPOS = [
  { id: "spm-project-2", label: "spm-project-2（SFA）" },
  { id: "spm-diagnosis", label: "spm-diagnosis（診断支援）" },
  { id: "peco-stock", label: "peco-stock（在庫管理）" },
  { id: "peco-property", label: "peco-property（物件検索）" },
  { id: "spm-dev-agent", label: "spm-dev-agent（このシステム）" },
  { id: "spm-pos", label: "spm-pos（POSシステム）" },
] as const;

export type RepoId = (typeof ALLOWED_REPOS)[number]["id"];

export function isAllowedRepo(value: string): value is RepoId {
  return ALLOWED_REPOS.some((r) => r.id === value);
}

export function repoPath(id: RepoId): string {
  return path.join(os.homedir(), id);
}
