// 既存プロジェクトを title のキーワードから事業カテゴリへ初期振り分けする。
// 実行: npm run categorize （内部で tsx 経由で実行される）
// 振り分けルールは src/lib/categories.ts の categorizeByTitle と共有。
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { categorizeByTitle, categoryLabel } from "../src/lib/categories";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

async function main() {
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    select: { id: true, title: true, businessCategory: true },
    orderBy: { updatedAt: "desc" },
  });

  console.log(`対象プロジェクト: ${projects.length}件\n`);

  let updated = 0;
  for (const p of projects) {
    const next = categorizeByTitle(p.title);
    const changed = p.businessCategory !== next;
    if (changed) {
      await prisma.project.update({
        where: { id: p.id },
        data: { businessCategory: next },
      });
      updated += 1;
    }
    const mark = changed ? "✏️ " : "  ";
    console.log(`${mark}${categoryLabel(next)}  ←  ${p.title.slice(0, 40)}`);
  }

  console.log(`\n完了: ${updated}件を更新しました。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
