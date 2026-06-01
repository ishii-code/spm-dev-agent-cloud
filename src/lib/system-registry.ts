import path from "node:path";
import { projectsRoot } from "./repos";

export interface SystemRuntime {
  id: string;
  label: string;
  description: string;
  port: number;
  dir: string;
  icon: string;
  color:
    | "peco-primary"
    | "peco-secondary"
    | "peco-info"
    | "peco-success"
    | "peco-warning"
    | "peco-danger";
}

export const SYSTEM_RUNTIMES: readonly SystemRuntime[] = [
  {
    id: "spm-project-2",
    label: "SFA",
    description: "営業支援・KPI管理システム",
    port: 3001,
    dir: path.join(projectsRoot(), "spm-project-2"),
    icon: "📊",
    color: "peco-info",
  },
  {
    id: "spm-diagnosis",
    label: "診断支援",
    description: "誤診ゼロ・診断AIエンジン",
    port: 3000,
    dir: path.join(projectsRoot(), "spm-diagnosis"),
    icon: "🤖",
    color: "peco-success",
  },
  {
    id: "peco-stock",
    label: "在庫管理 PecoStock",
    description: "在庫・発注・移動管理システム",
    port: 3002,
    dir: path.join(projectsRoot(), "peco-stock"),
    icon: "📦",
    color: "peco-warning",
  },
  {
    id: "peco-ui",
    label: "デザインシステム",
    description: "PECOデザイントークン・コンポーネント",
    port: 3003,
    dir: path.join(projectsRoot(), "peco-ui"),
    icon: "🎨",
    color: "peco-secondary",
  },
  {
    id: "peco-property",
    label: "物件検索",
    description: "出店候補物件スコアリングシステム",
    port: 3004,
    dir: path.join(projectsRoot(), "peco-property"),
    icon: "🏠",
    color: "peco-primary",
  },
  {
    id: "spm-dev-agent",
    label: "開発エージェント",
    description: "AI駆動開発管理システム",
    port: 3005,
    dir: path.join(projectsRoot(), "spm-dev-agent"),
    icon: "⚡",
    color: "peco-danger",
  },
] as const;

export function getSystemRuntime(id: string): SystemRuntime | null {
  return SYSTEM_RUNTIMES.find((s) => s.id === id) ?? null;
}
