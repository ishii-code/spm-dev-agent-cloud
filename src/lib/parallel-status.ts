// 並列実行ステートマシンの parallelStatus に関する定数。
// prisma 非依存（純データ）にして、worker ループ本体（parallel-tick.ts）と
// ユニットテストの双方から副作用なく import できるようにしている。

// processOneTick の dispatch が advance できる「in-flight」parallelStatus の全集合。
// worker ループ（claude-worker.ts）と起動時復旧（startup.ts）の唯一の取得経路である
// findRunnableProjects はこの集合を毎 tick 取得する。dispatch（processOneTick 内の分岐）と
// 一致していないと、その状態に遷移した project が二度と fetch されず state machine が停止する。
// （running→verifying 遷移後に findRunnableProjects が verifying を返さず永久停止していた欠陥の修正。
//   verifying / deploying / awaiting_qa は全 part が terminal のため resumeStuckProjects でも拾われない。）
//   - running                  : 通常の並列実行ドライバ
//   - scaffolding               : 新規 create-next-app（VM worker が拾って実行）
//   - verifying / needs_review  : 検証ゲート（advanceVerification・VM 限定）
//   - deploying / awaiting_qa   : プレビュー QA（advancePreviewQa・VM 限定）
// human-wait（needs_review / awaiting_qa）も含めるのは、人間入力（Slack リアクション/コメント）を
// 検出するため毎 tick ポーリングが必要なため。入力が無ければ各 advance は no_op で安価。
// advance 群は先頭で isExecHost() no_op ガード済み（Cloud Run 波及なし）＋ atomic claim で冪等。
export const RUNNABLE_PARALLEL_STATUSES = [
  "running",
  "scaffolding",
  "verifying",
  "needs_review",
  "deploying",
  "awaiting_qa",
] as const;
