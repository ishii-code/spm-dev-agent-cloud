// 「実装対象を確定」(ExecutorPanel) の純粋ロジック。
//   - buildConfirmTargetBody: 確定時に PATCH /api/projects/[id] へ送る body を組む。
//     核バグ修正(A): targetSystem/targetLabel に加え projectType を必ず同梱する
//     （"__new__" 選択時は "new"、既存システム選択時は "existing"）。これが無いと
//     新規リポジトリ確定時に projectType が作成時の値（例: "existing"）のまま残り、
//     canExecute=false で実行ボタンが永久に出ない／execute ルートも reject する。
//   - computeTargetGate: 確定済み状態の表示・実行可否（既存挙動をそのまま抽出）。
import { getSystem } from "./systems";
import { isAllowedRepo } from "./repos";
import type { ProjectType } from "./validation";

export interface ConfirmTargetBody {
  targetSystem: string;
  targetLabel: string;
  projectType: ProjectType;
}

export const NEW_TARGET_OPTION = "__new__";

// 確定ボタン押下時の送信 body を組む。対象が空なら null（呼び出し側は送信しない）。
export function buildConfirmTargetBody(
  localTarget: string,
  newRepoName: string,
): ConfirmTargetBody | null {
  const isNew = localTarget === NEW_TARGET_OPTION;
  const target = isNew ? newRepoName.trim() : localTarget;
  if (!target) return null;
  const label = isNew
    ? target
    : (getSystem(localTarget)?.label ?? target);
  return {
    targetSystem: target,
    targetLabel: label,
    projectType: isNew ? "new" : "existing",
  };
}

export interface TargetGate {
  isNewRepo: boolean;
  canExecute: boolean;
}

// 確定済みプロジェクトの実行可否判定（既存 ChatWorkspace の挙動を不変で抽出）。
//   isNewRepo  = 新規リポジトリ（projectType==="new"）として確定済みか
//   canExecute = 実行ボタンを表示してよいか
export function computeTargetGate(args: {
  targetSystem: string | null;
  projectType: ProjectType | string | null;
}): TargetGate {
  const { targetSystem, projectType } = args;
  const isNewRepo = projectType === "new" && targetSystem !== null;
  const canExecute =
    targetSystem !== null && (isAllowedRepo(targetSystem) || isNewRepo);
  return { isNewRepo, canExecute };
}
