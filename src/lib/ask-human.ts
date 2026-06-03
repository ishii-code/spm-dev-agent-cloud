// [[ASK_HUMAN]] マーカーの厳格パーサ（HITL）。prisma 等に依存しない純粋関数として切り出し、
// 単体テスト可能にする（parallel-tick から import）。
//
// 仕様：
//   - 専用行・行頭・1行・必須キー q を持つ正しい JSON のときのみ {q, choices} を返す。
//   - パース失敗 / q 欠落 / choices 非配列 → null（誤検出で止めない＝通常出力扱い）。
//   - q が `<...>` プレースホルダ（例文の echo 等）なら ASK_HUMAN 扱いせず通常出力へフォールバック
//     （preamble の例 `[[ASK_HUMAN]] {"q":"<具体的で1文の質問>",...}` を実発火と衝突させないため）。
//   - 複数あれば最後のものを採用。
const PLACEHOLDER_Q = /^\s*<.*>\s*$/; // 例文プレースホルダ（<具体的で1文の質問> 等）

export function parseAskHuman(log: string): { q: string; choices: string[] } | null {
  let found: { q: string; choices: string[] } | null = null;
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^\s*\[\[ASK_HUMAN\]\]\s*(\{.*\})\s*$/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]) as { q?: unknown; choices?: unknown };
      if (typeof obj.q !== "string" || obj.q.trim().length === 0) continue;
      // 例文プレースホルダ（<...>）は実質問ではない → 誤検知防止で通常出力扱い。
      if (PLACEHOLDER_Q.test(obj.q.trim())) continue;
      const choices = Array.isArray(obj.choices)
        ? obj.choices.filter((c): c is string => typeof c === "string")
        : [];
      found = { q: obj.q.trim(), choices };
    } catch {
      // JSON パース失敗は通常出力扱い
    }
  }
  return found;
}
