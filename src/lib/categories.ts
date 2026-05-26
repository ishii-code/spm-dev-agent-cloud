// 事業カテゴリ定義（システム一覧のグルーピング・プロジェクト分類で共有）
// schema.prisma の enum BusinessCategory と 1:1 で対応させること。

export interface BusinessCategoryMeta {
  id: BusinessCategoryId;
  emoji: string;
  name: string; // 日本語名（絵文字なし）
}

export const BUSINESS_CATEGORIES = [
  { id: "clinic_ops", emoji: "🏥", name: "クリニック運営" },
  { id: "medical_ai", emoji: "🤖", name: "メディカルAI" },
  { id: "biz_marketing", emoji: "💼", name: "経営・マーケティング" },
  { id: "data_platform", emoji: "📊", name: "データ基盤" },
  { id: "dev_tools", emoji: "🛠️", name: "開発・運用ツール" },
  { id: "experimental", emoji: "🧪", name: "実験・検証" },
  { id: "uncategorized", emoji: "📦", name: "未分類" },
] as const;

export type BusinessCategoryId = (typeof BUSINESS_CATEGORIES)[number]["id"];

export const DEFAULT_BUSINESS_CATEGORY: BusinessCategoryId = "uncategorized";

export const BUSINESS_CATEGORY_IDS = BUSINESS_CATEGORIES.map((c) => c.id) as readonly BusinessCategoryId[];

export function isBusinessCategory(value: unknown): value is BusinessCategoryId {
  return typeof value === "string" && BUSINESS_CATEGORY_IDS.includes(value as BusinessCategoryId);
}

export function getCategory(id: string | null | undefined): BusinessCategoryMeta {
  const found = BUSINESS_CATEGORIES.find((c) => c.id === id);
  return found ?? BUSINESS_CATEGORIES[BUSINESS_CATEGORIES.length - 1]; // uncategorized
}

// 絵文字 + 日本語名（例：「🏥 クリニック運営」）
export function categoryLabel(id: string | null | undefined): string {
  const c = getCategory(id);
  return `${c.emoji} ${c.name}`;
}

// タイトルからカテゴリを推定する初期振り分けルール（categorize スクリプトと共有）。
// 上から順に最初にマッチしたカテゴリを採用する。
const CATEGORY_KEYWORDS: { id: BusinessCategoryId; keywords: string[] }[] = [
  { id: "clinic_ops", keywords: ["POS", "予約", "EMR", "電子カルテ", "診療", "クリニック"] },
  { id: "medical_ai", keywords: ["AI", "LLM", "診断", "画像認識", "PECO Medical", "PM"] },
  { id: "biz_marketing", keywords: ["SFA", "KPI", "マーケ", "広告", "経営", "予算"] },
  { id: "data_platform", keywords: ["データ", "dbt", "分析", "ETL", "Snowflake", "FHIR"] },
  { id: "dev_tools", keywords: ["spm-dev-agent", "自動化", "ディグロス"] },
  { id: "experimental", keywords: ["to-do", "カウンター", "HTTP", "テスト", "実験", "サンプル", "ブログサイト"] },
];

export function categorizeByTitle(title: string | null | undefined): BusinessCategoryId {
  const t = title ?? "";
  for (const { id, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => t.includes(kw))) return id;
  }
  return DEFAULT_BUSINESS_CATEGORY;
}
