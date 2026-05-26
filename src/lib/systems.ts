export interface SystemMeta {
  id: string;       // targetSystem 値（DBに保存）
  label: string;    // 表示ラベル（targetLabel に保存）
  shortLabel: string; // バッジ・サイドバーで使う短い表示
  repoId?: string;  // ALLOWED_REPOS に対応するもの
}

export const SYSTEMS: readonly SystemMeta[] = [
  { id: "spm-project-2", label: "SFA（spm-project-2）", shortLabel: "SFA", repoId: "spm-project-2" },
  { id: "spm-diagnosis", label: "診断支援（spm-diagnosis）", shortLabel: "診断支援", repoId: "spm-diagnosis" },
  { id: "peco-stock", label: "在庫管理 PecoStock（peco-stock）", shortLabel: "PecoStock", repoId: "peco-stock" },
  { id: "peco-property", label: "物件検索 peco-property（peco-property）", shortLabel: "物件検索", repoId: "peco-property" },
  { id: "peco-ui", label: "デザインシステム（peco-ui）", shortLabel: "デザインシステム" },
  { id: "spm-dev-agent", label: "開発エージェント（spm-dev-agent）", shortLabel: "開発エージェント", repoId: "spm-dev-agent" },
  { id: "spm-pos", label: "POSシステム（spm-pos）", shortLabel: "POS", repoId: "spm-pos" },
  { id: "other", label: "その他", shortLabel: "その他" },
] as const;

export type SystemId = (typeof SYSTEMS)[number]["id"];

export function isSystemId(value: string): value is SystemId {
  return SYSTEMS.some((s) => s.id === value);
}

export function getSystem(id: string | null | undefined): SystemMeta | null {
  if (!id) return null;
  return SYSTEMS.find((s) => s.id === id) ?? null;
}

export const NEW_GROUP_LABEL = "新規アプリ";
