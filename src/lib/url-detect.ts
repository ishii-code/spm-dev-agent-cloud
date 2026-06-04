// 要件協議中にユーザー発言へ貼られた URL の検知と「読めない理由」の分類（純粋・依存なし）。
//
// Phase1 の責務は「黙殺しない」こと：取得は未実装のため、検知した URL は必ず
// 理由付きバブルで「読めません＋代替（内容を貼ってください）」を返す。
//   - auth_required : Notion / Google Docs 等、認証壁があり連携前提のドメイン
//   - no_tool       : それ以外（現状 URL 取得手段が無いため一律こちら）
// Phase2 で公開 URL の実取得を追加した際に forbidden/not_found/fetch_failed を足す想定。

export type UrlReason = "auth_required" | "no_tool";

export interface ClassifiedUrl {
  url: string;
  reason: UrlReason;
}

// 認証壁があり「内部連携 token + 対象共有」が無いと読めない代表ドメイン。
// host の末尾一致で判定（サブドメインを許容： foo.notion.site 等）。
const AUTH_REQUIRED_HOSTS = [
  "notion.so",
  "notion.site",
  "docs.google.com",
  "drive.google.com",
  "sheets.google.com",
  "slides.google.com",
  "atlassian.net", // Confluence / Jira
  "sharepoint.com",
];

// テキストから URL を抽出する。
//  - http/https のみ対象（mailto/ftp 等は無視）。
//  - 末尾に付きがちな句読点・括弧（日本語含む）を除去。
//  - 同一 URL は重複排除（出現順を維持）。
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"'）)】」』]+/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.match(re) ?? []) {
    const url = stripTrailingPunctuation(raw);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// URL 末尾に紛れ込みやすい句読点・閉じ括弧を削る（半角/全角）。
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?。、，．）)\]】」』>"']+$/u, "");
}

// URL の host を安全に取り出す（解析不能なら null）。
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// host が指定ドメイン（末尾一致）かどうか。example.com は example.com / a.example.com に一致。
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// 1 URL を分類する。Phase1 では auth_required / no_tool の 2 値。
export function classifyUrl(url: string): ClassifiedUrl {
  const host = hostOf(url);
  if (host && AUTH_REQUIRED_HOSTS.some((d) => hostMatches(host, d))) {
    return { url, reason: "auth_required" };
  }
  return { url, reason: "no_tool" };
}

// 理由コード → ユーザー向け説明文。
function reasonText(reason: UrlReason): string {
  switch (reason) {
    case "auth_required":
      return "認証が必要なサービス（Notion / Google Docs 等）で、未連携のため中身を読めません";
    case "no_tool":
      return "現在 URL の中身を自動取得する手段がないため読めません";
  }
}

// 検知した URL 群から「読めません」バブルの本文を組み立てる。
// 読める/対象が無い場合は null（=バブル不要）。
export function buildUnreadableUrlNotice(text: string): string | null {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  const lines = urls.map((u) => {
    const { reason } = classifyUrl(u);
    return `• ${u}\n  → ${reasonText(reason)}`;
  });

  return (
    "🔗 共有いただいた URL の中身は読み取れませんでした。\n\n" +
    lines.join("\n") +
    "\n\nお手数ですが、参照してほしい内容をこのチャットに直接貼り付けてください。要件に反映します。"
  );
}
