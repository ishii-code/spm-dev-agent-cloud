// 要件協議中にユーザー発言へ貼られた URL の検知と「読めない理由」の分類（純粋・依存なし）。
//
// Phase1 の責務は「黙殺しない」こと：取得は未実装のため、検知した URL は必ず
// 理由付きバブルで「読めません＋代替（内容を貼ってください）」を返す。
//   - auth_required : Notion / Google Docs 等、認証壁があり連携前提のドメイン
//   - no_tool       : それ以外（現状 URL 取得手段が無いため一律こちら）
// Phase2 で公開 URL の実取得を追加した際に forbidden/not_found/fetch_failed を足す想定。

export type UrlReason =
  | "auth_required" // 認証壁（Notion/Docs 等、または login へ誘導）
  | "forbidden" // 401/403
  | "not_found" // 404
  | "fetch_failed" // timeout / network / 非HTML / その他取得失敗
  | "blocked" // SSRF ガード（内部アドレス等）で取得しない
  | "no_tool"; // 取得手段が無い（Phase1 互換フォールバック）

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
export function reasonText(reason: UrlReason): string {
  switch (reason) {
    case "auth_required":
      return "認証が必要なサービス（Notion / Google Docs 等）で、未連携のため中身を読めません";
    case "forbidden":
      return "アクセス権限がなく読めません（401/403）。共有設定をご確認ください";
    case "not_found":
      return "URL が見つかりませんでした（404）";
    case "fetch_failed":
      return "取得に失敗しました（タイムアウト/ネットワーク/非HTML 等）";
    case "blocked":
      return "内部アドレス等のため安全上取得しません";
    case "no_tool":
      return "現在 URL の中身を自動取得する手段がないため読めません";
  }
}

// ===================================================================
// SSRF ガード（純粋判定）。fetch する前に host / 解決IP をこの関数群で検査する。
//   - 取得側（url-fetch.ts）は「ホスト名リテラル拒否」＋「DNS 解決後の各IP拒否」で
//     二段に使う。DNS リバインディングの残余リスクはリダイレクト毎の再検査で緩和。
// ===================================================================

// 取得を禁止するホスト名（リテラル一致 / サフィックス）。
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP メタデータ
  "metadata", // 同上の短縮
]);

// ホスト名（IP でない）が明らかに内部向けかどうか。
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true; // mDNS
  if (h.endsWith(".internal")) return true; // GCP/内部
  return false;
}

// IPv4 文字列を 4 オクテットに（不正なら null）。
function parseIpv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map((x) => Number.parseInt(x, 10));
  if (o.some((n) => n < 0 || n > 255)) return null;
  return o;
}

// プライベート/予約 IPv4 か（loopback・private・link-local(169.254 含む)・CGNAT・0.0.0.0 等）。
export function isPrivateIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local（169.254.169.254 メタデータ含む）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224+ multicast/reserved
  return false;
}

// プライベート/予約 IPv6 か（::1, ::, ULA fc00::/7, link-local fe80::/10, IPv4射影/互換）。
export function isPrivateIpv6(ip: string): boolean {
  let h = ip.toLowerCase();
  // ゾーンID除去（fe80::1%eth0）
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  if (h === "::1" || h === "::") return true;
  // IPv4-mapped/compat（::ffff:a.b.c.d / ::a.b.c.d）→ 埋め込み IPv4 を検査
  const v4 = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && (h.startsWith("::ffff:") || h.startsWith("::") )) {
    return isPrivateIpv4(v4[1]);
  }
  const first = h.split(":")[0];
  const head = Number.parseInt(first || "0", 16);
  if (Number.isNaN(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

// 解決済みアドレス（IPv4/IPv6 リテラル）が内部向けかどうか。
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}
