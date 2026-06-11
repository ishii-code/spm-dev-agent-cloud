// 復帰/再マウント時に「保存済み DB messages」と「sessionStorage の即時キャッシュ」の
// どちらを最終表示にするかの純粋判定。React/DOM に依存せず単体テスト可能にする。
//
// ③表示バグ: 旧 ChatWorkspace は復帰時に DB 全文を取得しても、sessionStorage の
// ストリーミング途中版で必ず上書きしていた → 途切れたバブルが残った。
// 方針: DB を最終真実源にする。ただし「この tab で実ストリーミング中」のときだけ
// 進行中の live(cache) を保持し、DB fetch で消さない（回帰防止）。

// 実ストリーミング中(this tab) かつ キャッシュが非空 のときだけ cache を優先する。
// それ以外（遷移→復帰など reader 破棄済み＝非ストリーミング）は false ＝ DB を採用。
export function preferCachedOnLoad(
  isStreaming: boolean,
  cached: unknown[] | null | undefined,
): boolean {
  return isStreaming === true && Array.isArray(cached) && cached.length > 0;
}

// 即時プレースホルダ用に、キャッシュ中の「固まったカーソル(pending)」を落とす。
// 復帰直後に途中カーソルを残さないため（表示は最終的に DB 全文へ置換される）。
// 非破壊（新しい配列を返す）。
export function stripPending<T extends { pending?: boolean }>(msgs: T[]): T[] {
  return msgs.map((m) => (m.pending ? { ...m, pending: false } : m));
}
