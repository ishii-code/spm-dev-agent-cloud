// scaffold に失敗した（または scaffolding_active で取り残された）新規プロジェクトを
// 再 scaffold 可能な状態に戻す手動リトライスクリプト（自動リトライは行わない）。
//   使い方: npm run retry-scaffold <projectId>
//
// parallelStatus を 'scaffold_error' / 'scaffolding_active' → 'scaffolding' に戻すと、
// VM worker の次ポーリングで create-next-app を再実行する。
// ※ parallel-tick.ts のステートマシンには手を入れず、DB 操作のみ行う（kill-project.js と同方式）。
require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("エラー: プロジェクトIDが必要です");
    console.error("使い方: npm run retry-scaffold <projectId>");
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
    const res = await client.query(
      `UPDATE "Project"
       SET "parallelStatus" = 'scaffolding', "parallelRunId" = NULL
       WHERE id = $1
         AND "parallelStatus" IN ('scaffold_error', 'scaffolding_active')
       RETURNING title, "parallelWorkingDir", "parallelStatus"`,
      [projectId],
    );
    if (res.rowCount === 0) {
      const cur = await client.query(
        'SELECT "parallelStatus" FROM "Project" WHERE id = $1',
        [projectId],
      );
      if (cur.rowCount === 0) {
        console.error(`エラー: プロジェクトが見つかりません: ${projectId}`);
      } else {
        console.error(
          `対象外: parallelStatus='${cur.rows[0].parallelStatus}'（scaffold_error / scaffolding_active のみリトライ可）`,
        );
      }
      process.exit(1);
    }
    console.log(`✅ 再 scaffold 待ちに戻しました: ${res.rows[0].title}`);
    console.log(`   生成先: ${res.rows[0].parallelWorkingDir}`);
    console.log(`   VM worker の次ポーリングで create-next-app を再実行します。`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("エラー:", e.message);
  process.exit(1);
});
