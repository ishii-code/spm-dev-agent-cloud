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

// プロジェクト群の親ディレクトリ。VM(Linux)では実行ユーザの HOME とリポジトリの
// 置き場所が異なるため、SPM_PROJECTS_ROOT で上書き可能にする。
// 未設定なら従来どおり os.homedir() を基点にする。
export function projectsRoot(): string {
  const fromEnv = process.env.SPM_PROJECTS_ROOT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : os.homedir();
}

export function repoPath(id: RepoId): string {
  return path.join(projectsRoot(), id);
}

// 新規プロジェクト（create-next-app で scaffold する新規リポジトリ）の親ディレクトリ。
// scaffold は VM worker 上の恒久ディレクトリで実行する必要があるため、
// 既存リポジトリの projectsRoot() とは分離する。
//   - 既定: /home/ishiitakeshi/spm-projects（VM worker 実行ユーザの恒久パス）
//   - SPM_NEW_PROJECTS_ROOT で上書き可能（env 未設定でも既定で動く）
//   - /root・/tmp 配下は ephemeral／FS 非共有のため明示的に拒否する
const FORBIDDEN_NEW_PROJECT_ROOTS = ["/root", "/tmp"] as const;
const DEFAULT_NEW_PROJECTS_ROOT = "/home/ishiitakeshi/spm-projects";

export function newProjectsRoot(): string {
  const fromEnv = process.env.SPM_NEW_PROJECTS_ROOT?.trim();
  const root =
    fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_NEW_PROJECTS_ROOT;
  const normalized = path.resolve(root);
  for (const forbidden of FORBIDDEN_NEW_PROJECT_ROOTS) {
    if (normalized === forbidden || normalized.startsWith(forbidden + path.sep)) {
      throw new Error(
        `SPM_NEW_PROJECTS_ROOT must not be under ${forbidden} ` +
          `(ephemeral / not shared with VM worker): got ${normalized}`,
      );
    }
  }
  return normalized;
}

export function newProjectPath(repo: string): string {
  return path.join(newProjectsRoot(), repo);
}
