-- アカウント機能 Phase1：仮PW強化＋監査ログ。全て additive・nullable で後方互換。
-- 既存稼働（worker / Cloud Run）は新カラム/新テーブルを無視可。

-- 仮パスワードの短命有効期限（mustChangePassword かつ now>これ ならログイン拒否）
ALTER TABLE "users" ADD COLUMN "temp_password_expires_at" TIMESTAMP(3);

-- 承認/HITL 通知のオーナーメンション用 Slack User ID（Phase3 で使用）
ALTER TABLE "users" ADD COLUMN "slack_id" TEXT;

-- 認証監査ログ（append-only）。パスワード・トークンは保存しない。
CREATE TABLE "auth_audit_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "email" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_audit_logs_created_at_idx" ON "auth_audit_logs"("created_at");
CREATE INDEX "auth_audit_logs_email_idx" ON "auth_audit_logs"("email");
