import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
const prisma = new PrismaClient({ adapter });

// 初期管理者アカウント。本人が初回ログイン後に必ずパスワードを変更する（mustChangePassword=true）。
// 既存 email はパスワード上書きしない（運用中アカウント事故防止）。
const ADMIN_SEED = {
  email: "takeshi.ishii@peco-japan.com",
  name: "石井 豪",
  initialPassword: "PecoAdmin2026!",
};

async function seedAdmin(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_SEED.email } });
  if (existing) {
    console.log(`Admin user already exists: ${ADMIN_SEED.email} (skipping)`);
    return;
  }
  await prisma.user.create({
    data: {
      email: ADMIN_SEED.email,
      name: ADMIN_SEED.name,
      passwordHash: await bcrypt.hash(ADMIN_SEED.initialPassword, 10),
      role: "ADMIN",
      mustChangePassword: true,
    },
  });
  console.log(`Created admin user: ${ADMIN_SEED.email}`);
}

const SEED_APPS = [
  {
    name: "SFA 営業支援システム",
    description: "顧客管理・商談管理・営業活動の記録と分析",
    status: "COMPLETED" as const,
    techStack: "Next.js / PostgreSQL / Prisma",
    portNumber: 3001,
    businessCategory: "biz_marketing" as const,
    orgNames: ["CLINIC_DEV", "OPERATIONS"] as const,
  },
  {
    name: "AI診断支援システム",
    description: "獣医師向けAI診断アシスタント・症例分析",
    status: "IN_PROGRESS" as const,
    techStack: "Next.js / PostgreSQL / Claude API",
    portNumber: 3002,
    businessCategory: "medical_ai" as const,
    orgNames: ["CLINIC_DEV", "PRODUCT"] as const,
  },
  {
    name: "PecoStock 在庫管理",
    description: "医薬品・備品の在庫管理・発注管理",
    status: "IN_PROGRESS" as const,
    techStack: "Next.js / PostgreSQL / Prisma",
    portNumber: 3003,
    businessCategory: "clinic_ops" as const,
    orgNames: ["OPERATIONS", "BACK_OFFICE"] as const,
  },
  {
    name: "Peco Property 物件管理",
    description: "病院物件・設備の管理",
    status: "IN_PROGRESS" as const,
    techStack: "Next.js / PostgreSQL / Prisma",
    portNumber: 3004,
    businessCategory: "clinic_ops" as const,
    orgNames: ["BACK_OFFICE"] as const,
  },
  {
    name: "Peco UI コンポーネントライブラリ",
    description: "PECO共通UIコンポーネント・デザインシステム",
    status: "IN_PROGRESS" as const,
    techStack: "Next.js / Tailwind CSS / shadcn/ui",
    portNumber: 3005,
    businessCategory: "dev_tools" as const,
    orgNames: ["PRODUCT"] as const,
  },
  {
    name: "SPM 開発エージェント",
    description: "AI駆動の開発支援・プロジェクト管理・エージェントオーケストレーション",
    status: "IN_PROGRESS" as const,
    techStack: "Next.js / PostgreSQL / Claude API / Prisma",
    portNumber: 3000,
    businessCategory: "dev_tools" as const,
    orgNames: ["PRODUCT", "CLINIC_DEV"] as const,
  },
];

async function main() {
  await seedAdmin();

  console.log("Seeding portfolio apps...");

  for (const app of SEED_APPS) {
    const existing = await prisma.appPortfolio.findFirst({ where: { name: app.name } });
    if (existing) {
      // 既存行は保持しつつ businessCategory のみ初期値へ補正（未割り当ての場合）
      if (existing.businessCategory !== app.businessCategory) {
        await prisma.appPortfolio.update({
          where: { id: existing.id },
          data: { businessCategory: app.businessCategory },
        });
        console.log(`Updated category: ${app.name} -> ${app.businessCategory}`);
      } else {
        console.log(`Skipping existing: ${app.name}`);
      }
      continue;
    }
    await prisma.appPortfolio.create({
      data: {
        name: app.name,
        description: app.description,
        status: app.status,
        techStack: app.techStack,
        portNumber: app.portNumber,
        businessCategory: app.businessCategory,
        isFromCode: true,
        orgMappings: {
          create: app.orgNames.map((orgName) => ({ orgName })),
        },
      },
    });
    console.log(`Created: ${app.name}`);
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
