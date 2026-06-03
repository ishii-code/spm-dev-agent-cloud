// プロジェクト書込/実行の認可判定（純粋・依存なし＝サーバ/クライアント共用）。
// サーバ(requireProjectAccess)とクライアント(UI 出し分け)で同一関数を使い判定をドリフトさせない。
//   ADMIN=allow / 一般は ownerId===userId なら allow / null-owner は allow（レガシー開放） / 他人 forbid
export function decideProjectAccess(
  role: "ADMIN" | "USER",
  userId: number,
  ownerId: number | null,
): "allow" | "forbid" {
  if (role === "ADMIN") return "allow";
  if (ownerId == null) return "allow";
  return ownerId === userId ? "allow" : "forbid";
}
