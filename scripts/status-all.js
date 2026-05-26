// 全プロジェクトの並列実行状態を一覧表示するデバッグ用スクリプト（改善10）。
//   使い方: npm run status-all
//
// 各プロジェクトの parallelStatus / parallelRunId と各 Part の状態を表示し、
// 実プロセス（SPM_RUN_ID を含むコマンド）と照合する。
// executing なのに対応プロセスが生きていない Part を警告として出力する。
require("dotenv").config();
const { Client } = require("pg");
const { execSync } = require("child_process");

function countRunningProcesses() {
  try {
    const out = execSync(
      "ps -eo pid,command | grep SPM_RUN_ID | grep -v grep",
      { encoding: "utf-8" },
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // grep はマッチ 0 件で exit code 1 を返すため、ここに来たら 0 件扱い
    return [];
  }
}

function isPidAlive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0); // シグナル 0 = 存在確認のみ
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("エラー: DATABASE_URL が未設定です（.env を確認）");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const projects = await client.query(
      `SELECT id, title, "parallelStatus", "parallelRunId"
       FROM "Project"
       WHERE "archivedAt" IS NULL
       ORDER BY "updatedAt" DESC`,
    );

    for (const p of projects.rows) {
      const parts = await client.query(
        `SELECT "partNumber", "executionStatus", "approvalState"
         FROM "Document"
         WHERE "projectId" = $1 AND "partNumber" IS NOT NULL
         ORDER BY "partNumber" ASC`,
        [p.id],
      );
      const partStr = parts.rows
        .map((d) => {
          const appr =
            d.approvalState === "approved" ? " (approved)" : "";
          return `${d.partNumber}: ${d.executionStatus}${appr}`;
        })
        .join(", ");
      console.log(`Project: ${p.title} (${p.id})`);
      console.log(
        `  parallelStatus: ${p.parallelStatus ?? "NULL"} | parallelRunId: ${p.parallelRunId ?? "NULL"}`,
      );
      console.log(`  Parts: [${partStr}]`);
      console.log("");
    }

    // 実プロセス照合
    const procLines = countRunningProcesses();
    console.log(
      `Running processes: ${procLines.length} SPM_RUN_ID processes alive`,
    );

    // executing なのにプロセスが生きていない Part を警告
    const executing = await client.query(
      `SELECT p.title, d."partNumber", d."execPid"
       FROM "Document" d
       JOIN "Project" p ON p.id = d."projectId"
       WHERE d."executionStatus" = 'executing' AND p."archivedAt" IS NULL
       ORDER BY p.title, d."partNumber"`,
    );
    const warnings = [];
    for (const row of executing.rows) {
      if (!isPidAlive(row.execPid)) {
        warnings.push(
          `  - ${row.title} Part${row.partNumber} (execPid=${row.execPid ?? "NULL"}): executing だがプロセス無し`,
        );
      }
    }
    if (warnings.length === 0) {
      console.log("⚠ 警告: なし");
    } else {
      console.log("⚠ 警告: executing なのにプロセスが見つからない Part:");
      console.log(warnings.join("\n"));
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("エラー:", e.message);
  process.exit(1);
});
