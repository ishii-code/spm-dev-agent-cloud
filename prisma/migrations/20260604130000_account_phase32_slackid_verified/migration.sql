-- アカウント機能 Phase3.2：Slack ID 動作確認（users.info 解決）済み時刻。
-- additive・nullable で後方互換。既存稼働は新カラムを無視可。

-- Slack ID の動作確認済み時刻（null＝未検証）。プロジェクト作成 gate の判定に使用。
ALTER TABLE "users" ADD COLUMN "slack_id_verified_at" TIMESTAMP(3);
