// 公開 URL のサーバ side 取得（Phase2）。SSRF 対策・timeout・サイズ上限つき。
//
// 方針：
//  - http/https のみ。host リテラル拒否＋DNS 解決後の各IPを isPrivateAddress で拒否。
//    リダイレクトは manual で辿り、各ホップで再検査（DNS リバインディング緩和）。
//  - 取得成功時は「要約せず」本文をプレーン化し上限文字数で返す（fidelity 維持）。
//  - 失敗は url-detect.ts の UrlReason に分類（auth_required/forbidden/not_found/
//    fetch_failed/blocked）。Notion/Docs 等は取得前に classifyUrl で auth_required。
//  - 残余リスク：undici は connect 時に再解決するため厳密なIPピンニングはしていない。
//    社内ユーザー前提の開発ツールとして per-hop 検査＋メタデータ/loopback/private 拒否で許容。
import { lookup } from "node:dns/promises";
import {
  classifyUrl,
  extractUrls,
  isBlockedHostname,
  isPrivateAddress,
  reasonText,
  type UrlReason,
} from "./url-detect";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000; // 取得本文の最大バイト数
const MAX_TEXT = 6000; // モデル注入する本文の最大文字数
const MAX_REDIRECTS = 3;
const EXCERPT_LEN = 120; // バブル「要約」表示用の抜粋長

export type FetchOutcome =
  | { ok: true; url: string; text: string; title: string | null }
  | { ok: false; url: string; reason: UrlReason };

// host が IP リテラルか（ブラケット付き IPv6 も許容）。
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// テスト専用シーム：loopback への取得を許可（既定 OFF）。統合テストでローカル HTTP
// サーバへ実アクセスして分類を検証するためだけに使う。本番では絶対に設定しない。
const ALLOW_LOOPBACK = process.env.URL_FETCH_ALLOW_LOOPBACK === "1";
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// URL が取得許可されるか検査。NG なら UrlReason を返す（許可なら null）。
async function checkAllowed(u: URL): Promise<UrlReason | null> {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "fetch_failed";
  const host = stripBrackets(u.hostname);
  if (!host) return "fetch_failed";
  if (ALLOW_LOOPBACK && isLoopbackHost(host)) return null; // テスト専用バイパス
  if (isBlockedHostname(host)) return "blocked";
  // host が IP リテラルなら直接判定、ホスト名なら DNS 解決して全アドレス検査。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return isPrivateAddress(host) ? "blocked" : null;
  }
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return "fetch_failed";
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) return "blocked";
    }
    return null;
  } catch {
    return "fetch_failed"; // 名前解決不可
  }
}

// login へ誘導する URL かどうか（auth_required 判定の補助）。
function looksLikeLoginUrl(u: URL): boolean {
  const s = `${u.hostname}${u.pathname}`.toLowerCase();
  return (
    /(^|\.)accounts\.google\.com$/.test(u.hostname) ||
    /(^|\.)login\.microsoftonline\.com$/.test(u.hostname) ||
    /\/(login|signin|sign-in|auth|sso|oauth)(\/|$|\?)/.test(s)
  );
}

// HTML 本文に login フォームの痕跡があるか（200 で実際は login 画面のケース）。
function looksLikeLoginHtml(html: string): boolean {
  const h = html.toLowerCase();
  const hasPassword = /<input[^>]+type=["']?password/.test(h);
  const hasLoginWord = /(sign in|signin|log in|login|ログイン|サインイン)/.test(h);
  return hasPassword && hasLoginWord;
}

// HTML → プレーンテキスト（script/style 除去・タグ除去・空白圧縮）。要約はしない。
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/[ \t　]+/g, " ").replace(/\n[ \t]*\n[\s\n]*/g, "\n\n");
  return s.trim();
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) || null : null;
}

// HTTP ステータス → UrlReason（2xx 以外）。
function statusToReason(status: number): UrlReason {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "fetch_failed";
}

// レスポンス body をサイズ上限つきで読む。
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// 1 URL を取得して分類。auth ドメインは取得せず即 auth_required。
export async function fetchUrlContent(rawUrl: string): Promise<FetchOutcome> {
  const pre = classifyUrl(rawUrl);
  if (pre.reason === "auth_required") {
    return { ok: false, url: rawUrl, reason: "auth_required" };
  }

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, reason: "fetch_failed" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const blockReason = await checkAllowed(current);
      if (blockReason) return { ok: false, url: rawUrl, reason: blockReason };

      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "spm-dev-agent-bot/1.0", accept: "text/html,text/plain" },
      });

      // リダイレクト：login 誘導なら auth_required、それ以外は次ホップを再検査して追従。
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, url: rawUrl, reason: "fetch_failed" };
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return { ok: false, url: rawUrl, reason: "fetch_failed" };
        }
        if (looksLikeLoginUrl(next)) return { ok: false, url: rawUrl, reason: "auth_required" };
        current = next;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, url: rawUrl, reason: statusToReason(res.status) };
      }

      const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!ctype.includes("text/html") && !ctype.includes("text/plain") && ctype !== "") {
        return { ok: false, url: rawUrl, reason: "fetch_failed" }; // 非HTML
      }

      const body = await readCapped(res);
      if (ctype.includes("text/html") && looksLikeLoginHtml(body)) {
        return { ok: false, url: rawUrl, reason: "auth_required" };
      }
      const text = (ctype.includes("text/html") ? htmlToText(body) : body)
        .slice(0, MAX_TEXT)
        .trim();
      if (!text) return { ok: false, url: rawUrl, reason: "fetch_failed" };
      const title = ctype.includes("text/html") ? extractTitle(body) : null;
      return { ok: true, url: rawUrl, text, title };
    }
    return { ok: false, url: rawUrl, reason: "fetch_failed" }; // リダイレクト上限
  } catch {
    return { ok: false, url: rawUrl, reason: "fetch_failed" }; // timeout/network
  } finally {
    clearTimeout(timer);
  }
}

export interface MessageUrlResult {
  notice: string | null; // ユーザー向けバブル（読込み✅＋読めない理由）。URL 無→null
  guard: string; // 読めない URL の推測・創作禁止ガード（モデル向け、無→""）
  injection: string; // 読めた URL の本文（モデル入力へ注入、無→""）
}

// メッセージ内の全 URL を取得・分類し、バブル/ガード/本文注入を組み立てる。
export async function processMessageUrls(text: string): Promise<MessageUrlResult> {
  const urls = extractUrls(text);
  if (urls.length === 0) return { notice: null, guard: "", injection: "" };

  const outcomes = await Promise.all(urls.map((u) => fetchUrlContent(u)));

  const readable = outcomes.filter((o): o is Extract<FetchOutcome, { ok: true }> => o.ok);
  const unreadable = outcomes.filter((o): o is Extract<FetchOutcome, { ok: false }> => !o.ok);

  // バブル
  const noticeLines: string[] = [];
  if (readable.length > 0) {
    noticeLines.push("✅ 次の URL を読み込み、要件に反映します。");
    for (const r of readable) {
      const excerpt = r.text.replace(/\s+/g, " ").slice(0, EXCERPT_LEN);
      noticeLines.push(`• ${r.url}\n  （要約：${excerpt}…）`);
    }
  }
  if (unreadable.length > 0) {
    if (noticeLines.length > 0) noticeLines.push("");
    noticeLines.push("🔗 次の URL の中身は読み取れませんでした。");
    for (const u of unreadable) {
      noticeLines.push(`• ${u.url}\n  → ${reasonText(u.reason)}`);
    }
    noticeLines.push("");
    noticeLines.push("参照してほしい内容はこのチャットに直接貼り付けてください。");
  }
  const notice = noticeLines.join("\n");

  // モデル向けガード（読めなかった URL のみ）
  let guard = "";
  if (unreadable.length > 0) {
    guard =
      `【重要・URL注意】次のURLは読み取れていない：${unreadable.map((u) => u.url).join(" , ")}。` +
      `これらの内容を推測・創作して要件に反映しないこと。必要なら本文の貼り付けをユーザーに促す。`;
  }

  // モデル向け本文注入（読めた URL のみ・要約せず上限付き）
  let injection = "";
  if (readable.length > 0) {
    injection = readable
      .map(
        (r) =>
          `【取得したURL本文】${r.url}${r.title ? `（${r.title}）` : ""}\n${r.text}\n【ここまで】`,
      )
      .join("\n\n");
  }

  return { notice, guard, injection };
}
