-- HITL（実行中の人間判断）用フィールド。全て nullable で後方互換（旧コードは無視可）。
-- executionStatus には 'needs_human' / 'blocked' という新しい文字列値が入る（型変更なし）。
ALTER TABLE "Document" ADD COLUMN "humanQuestion" TEXT;
ALTER TABLE "Document" ADD COLUMN "humanChoices" JSONB;
ALTER TABLE "Document" ADD COLUMN "humanQuestionTs" TEXT;
ALTER TABLE "Document" ADD COLUMN "humanAnswer" TEXT;
ALTER TABLE "Document" ADD COLUMN "humanAskedAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "humanRenotifiedAt" TIMESTAMP(3);
