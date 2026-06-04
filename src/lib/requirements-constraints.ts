// 要件協議でユーザーが提供した「具体制約」の構造化抽出と充足チェック（純粋・依存なし）。
//
// 目的（Phase A）：部屋/面積/機器/動線/コスト等の具体仕様が要約で潰れ落ちる欠陥への対策。
//  - extractConstraints：ユーザー発言から具体制約を「逐語の文＋シグナル語」で抽出（決定論）。
//  - findMissingConstraints：要件定義書にシグナルが現れない＝未反映の制約を検出。
//  - buildConstraintAppendix：未反映分を「原文転記」セクションとして逐語で復元（創作しない）。

export type ConstraintCategory = "area" | "cost" | "count" | "room" | "equipment" | "flow";

export interface Constraint {
  category: ConstraintCategory;
  signal: string; // 充足チェックの判定キー（面積値/室名/機器名 等）
  text: string; // 逐語転記用：シグナルを含む元の文
}

// 数値系（面積/コスト/個数）の正規表現。
const REGEX_RULES: { category: ConstraintCategory; re: RegExp }[] = [
  { category: "area", re: /\d+(?:\.\d+)?\s*(?:m²|㎡|m2|平米|平方メートル|坪)/g },
  { category: "cost", re: /\d[\d,]*\s*(?:億円|万円|円)/g },
  { category: "count", re: /\d+\s*(?:室|部屋|台|席|ブース|区画|床|名|頭)/g },
];

// キーワード系（室/機器/動線）。シグナル＝マッチしたキーワードそのもの。
const KEYWORD_RULES: { category: ConstraintCategory; words: string[] }[] = [
  {
    category: "room",
    words: ["診察室", "待合", "受付", "処置室", "オペ室", "手術室", "入院", "隔離室", "トイレ", "収納", "薬局", "カウンセリング", "レントゲン室", "処方", "受付カウンター"],
  },
  {
    category: "equipment",
    words: ["レントゲン", "エコー", "超音波", "血液検査", "麻酔器", "顕微鏡", "遠心分離", "オートクレーブ", "X線", "CT", "MRI", "保育器", "ICU"],
  },
  {
    category: "flow",
    words: ["動線", "導線", "ゾーニング", "聴覚分離", "隔離", "レイアウト", "配置", "パターンA", "パターンB", "A/Bパターン", "兼オペ"],
  },
];

// 空白除去（"120 ㎡" と "120㎡" を同一視）。全角空白も。
function norm(s: string): string {
  return s.replace(/[\s　]+/g, "");
}

// 文に分割（句点・改行・！？で素朴に区切る）。
function splitSentences(text: string): string[] {
  return text
    .split(/[。．\n\r！？!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

// テキストから具体制約を抽出。`${category}|${正規化signal}` で重複排除（出現順維持）。
export function extractConstraints(text: string): Constraint[] {
  if (!text) return [];
  const out: Constraint[] = [];
  const seen = new Set<string>();
  const push = (category: ConstraintCategory, signal: string, sentence: string) => {
    const key = `${category}|${norm(signal)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ category, signal: signal.trim(), text: sentence });
  };
  for (const sentence of splitSentences(text)) {
    for (const { category, re } of REGEX_RULES) {
      for (const m of sentence.match(re) ?? []) push(category, m, sentence);
    }
    for (const { category, words } of KEYWORD_RULES) {
      for (const w of words) if (sentence.includes(w)) push(category, w, sentence);
    }
  }
  return out;
}

// 要件定義書に「シグナルが現れない」制約＝未反映を返す。
export function findMissingConstraints(constraints: Constraint[], doc: string): Constraint[] {
  const ndoc = norm(doc);
  return constraints.filter((c) => !ndoc.includes(norm(c.signal)));
}

// 未反映の制約を「原文転記」セクションとして逐語で組み立てる（重複文は1回）。
// 創作はしない＝ユーザーが実際に書いた文をそのまま載せる。
export function buildConstraintAppendix(constraints: Constraint[]): string {
  if (constraints.length === 0) return "";
  const seenText = new Set<string>();
  const lines: string[] = [];
  for (const c of constraints) {
    if (seenText.has(c.text)) continue;
    seenText.add(c.text);
    lines.push(`- ${c.text}`);
  }
  return (
    "ユーザー提供の具体制約（原文転記・要約や省略をしないこと）\n" +
    lines.join("\n")
  );
}
