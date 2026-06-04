// 時刻整形の共有ユーティリティ。サーバ（Cloud Run/VM）は UTC で動くため、ユーザー向け
// 表示は必ず JST（Asia/Tokyo）に固定する。DB/API のシリアライズ（ISO 文字列）は UTC のまま
// で良い（曖昧さがなくクライアントが整形する）ため、ここは「人が読む表示」専用。
const JST = "Asia/Tokyo";

// 例: 2026/6/4 19:30:00（ja-JP・JST）
export function formatJst(d: Date = new Date()): string {
  return d.toLocaleString("ja-JP", { timeZone: JST });
}

// 例: 2026/6/4（ja-JP・JST）
export function formatJstDate(d: Date = new Date()): string {
  return d.toLocaleDateString("ja-JP", { timeZone: JST });
}
