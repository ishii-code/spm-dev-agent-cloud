import { readFileSync } from "node:fs";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * node-postgres は既定で平文接続するため、TLS 必須の DB（Cloud SQL の
 * sslMode=ENCRYPTED_ONLY 等）では pg_hba.conf に SQLSTATE 28000 で拒否され、
 * Prisma は P1010 "User was denied access on the database" に変換する。
 * psql は sslmode=prefer で自動的に TLS を張るため成功してしまい、症状が分かりにくい。
 *
 * ここでは接続先に応じて TLS を有効化する:
 *  - sslmode=disable（URL もしくは PGSSLMODE）→ 明示的に無効化
 *  - localhost / 127.0.0.1 で sslmode 指定なし → 従来どおり平文（ローカル開発）
 *  - それ以外（リモート）→ TLS 有効化。CA 証明書（DATABASE_SSL_CA / PGSSLROOTCERT）が
 *    あれば検証あり、なければ Cloud SQL の内部 CA を信頼できないため検証なしで暗号化のみ。
 */
function resolveSsl(connectionString: string): PoolConfig["ssl"] {
  let host = "";
  let sslmode: string | null = process.env.PGSSLMODE ?? null;
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    sslmode = url.searchParams.get("sslmode") ?? sslmode;
  } catch {
    // パース不能ならリモート扱い（安全側で TLS 有効化）
  }

  if (sslmode === "disable") {
    return false;
  }

  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  if (isLocal && !sslmode) {
    return undefined;
  }

  const caPath = process.env.DATABASE_SSL_CA ?? process.env.PGSSLROOTCERT;
  if (caPath) {
    return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({
    connectionString,
    ssl: resolveSsl(connectionString),
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
