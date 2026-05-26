// 特定プロジェクトだけ並列実行を停止する運用スクリプト（改善9）。
//   使い方: npm run kill-project <projectId>
//
// 全停止の `npm run kill-all` と違い、引数で渡した 1 プロジェクトだけを対象にする。
//   1) そのプロジェクトの executing な Document の execPid を SIGKILL
//   2) 当該 Document を awaiting_approval + approved に戻し execPid/execDoneFile を NULL
//   3) Project.parallelRunId = NULL, parallelStatus = 'paused'
// ※ parallel-tick.ts のステートマシンには手を入れず、kill-all と同じ DB 操作のみ行う。
require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("エラー: プロジェクトIDが必要です");
    console.error("使い方: npm run kill-project <projectId>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("エラー: DATABASE_URL が未設定です（.env を確認）");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const proj = await client.query(
      'SELECT id, title, "parallelStatus" FROM "Project" WHERE id = $1',
      [projectId],
    );
    if (proj.rowCount === 0) {
      console.error(`エラー: プロジェクトが見つかりません: ${projectId}`);
      process.exit(1);
    }
    const title = proj.rows[0].title;

    // executing な Document の execPid を取得して SIGKILL
    const execs = await client.query(
      `SELECT id, "partNumber", "execPid" FROM "Document"
       WHERE "projectId" = $1 AND "executionStatus" = 'executing'`,
      [projectId],
    );

    let killed = 0;
    for (const row of execs.rows) {
      const pid = row.execPid;
      if (pid == null) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++;
        console.log(`  SIGKILL → PID ${pid} (Part${row.partNumber})`);
      } catch {
        console.log(`  PID ${pid} は既に終了済み (Part${row.partNumber})`);
      }
    }

    // executing だった Document を再実行待ちに戻す
    const upd = await client.query(
      `UPDATE "Document"
       SET "executionStatus" = 'awaiting_approval', "approvalState" = 'approved',
           "execPid" = NULL, "execDoneFile" = NULL
       WHERE "projectId" = $1 AND "executionStatus" = 'executing'`,
      [projectId],
    );

    // Project を paused に
    await client.query(
      `UPDATE "Project"
       SET "parallelRunId" = NULL, "parallelStatus" = 'paused'
       WHERE id = $1`,
      [projectId],
    );

    console.log(`\n✅ プロジェクト「${title}」(${projectId}) を停止しました`);
    console.log(`   kill したプロセス     : ${killed} 件`);
    console.log(`   再実行待ちに戻した Part: ${upd.rowCount} 件`);
    console.log(`   parallelStatus='paused', parallelRunId=NULL`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("エラー:", e.message);
  process.exit(1);
});
