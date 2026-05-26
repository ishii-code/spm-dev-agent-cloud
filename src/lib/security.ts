import type { ApprovalType, SecurityCheckResult } from "@/types";

interface SecurityRule {
  type: ApprovalType;
  keywords: string[];
}

const RULES: SecurityRule[] = [
  {
    type: "auth",
    keywords: ["auth", "認証", "認可", "password", "token", "secret"],
  },
  {
    type: "db_schema",
    keywords: ["DROP", "DELETE", "migrate", "ALTER TABLE", "TRUNCATE"],
  },
  {
    type: "external_api",
    keywords: ["外部API", "external api", "webhook", "サードパーティ"],
  },
  {
    type: "security",
    keywords: ["個人情報", "医療データ", "医療", "カルテ", "PII", "PHI"],
  },
];

export function checkSecurity(text: string): SecurityCheckResult {
  const matched: { type: ApprovalType; keyword: string }[] = [];

  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      const pattern = new RegExp(
        keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      if (pattern.test(text)) {
        matched.push({ type: rule.type, keyword });
      }
    }
  }

  if (matched.length === 0) {
    return { requiresApproval: false, type: null, matchedKeywords: [] };
  }

  return {
    requiresApproval: true,
    type: matched[0].type,
    matchedKeywords: Array.from(new Set(matched.map((m) => m.keyword))),
  };
}
