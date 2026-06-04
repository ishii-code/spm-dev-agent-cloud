// 設計⇄要件の整合検証（Phase B）。設計生成直後・実装kickoff前に使う。
//  - precheckCoverage：決定論の安価な pre-check。要件の制約シグナルが設計に現れるか。
//    ※token 一致は「受付なし/受付あり」を区別できない＝除外・反転判定は不可。あくまで欠落の目安。
//  - buildDesignCriticPrompt：authoritative な critic（[[VERIFY]]）への指示。全項目カバー＋
//    仕様が除外した要素を足していないか（受付なし→受付を入れていないか等）を厳密判定させる。
// 判定パース（parseVerifyVerdict）は verify.ts を再利用する。
import { extractConstraints, type Constraint } from "./requirements-constraints";

function norm(s: string): string {
  return s.replace(/[\s　]+/g, "");
}

// 決定論 pre-check：要件から抽出した制約のうち、設計にシグナルが現れないもの（欠落の目安）。
export function precheckCoverage(requirementsDoc: string, designDoc: string): Constraint[] {
  const ndesign = norm(designDoc);
  return extractConstraints(requirementsDoc).filter((c) => !ndesign.includes(norm(c.signal)));
}

// critic（authoritative）へのプロンプト。要件↔設計を比較し最後に 1 行 [[VERIFY]] を出させる。
// missingHint は pre-check の欠落候補（critic への注意喚起。最終判定は critic 自身）。
export function buildDesignCriticPrompt(
  requirementsDoc: string,
  designDoc: string,
  missingHint: string[] = [],
): string {
  const hint =
    missingHint.length > 0
      ? `\n## 自動 pre-check が「設計に見当たらない」とした候補（要確認・最終判定はあなた）\n${missingHint.map((s) => `- ${s}`).join("\n")}\n`
      : "";
  return (
    `# 設計レビュー（要件↔設計の整合チェック）\n` +
    `要件定義書と設計書を突き合わせ、次の2点を厳密に判定してください。\n\n` +
    `1. カバレッジ：設計が要件の全項目（機能・非機能・具体制約＝部屋/面積/機器/動線/コスト）を反映しているか。落ちている項目はないか。\n` +
    `2. 仕様外混入・反転：要件にない要素や、要件が「除外」した要素を設計に足していないか。\n` +
    `   - 重要：否定・除外の反転を必ず確認すること。例「受付なし」とあるのに設計に受付/受付カウンターを入れていないか。\n` +
    `   - 「〜しない」「〜なし」「不要」と書かれた項目を設計が無視して追加していないか。\n` +
    hint +
    `\n## 要件定義書\n${(requirementsDoc || "(要件なし)").slice(0, 6000)}\n\n` +
    `## 設計書\n${(designDoc || "(設計なし)").slice(0, 6000)}\n\n` +
    `## 出力（厳守）\n` +
    `レビュー後、出力の最後に **次の1行だけ** を独立行で：\n` +
    `[[VERIFY]] {"verdict":"pass","reasons":[]}  ← 整合\n` +
    `または\n` +
    `[[VERIFY]] {"verdict":"fail","reasons":["未カバー: 〇〇","仕様外混入: 〇〇"]}\n` +
    `- reasons は「未カバー: …」「仕様外混入: …」の形で具体的に。プレースホルダ <…> は書かない。\n` +
    `- JSON は1行・ダブルクオート・改行なし。`
  );
}
