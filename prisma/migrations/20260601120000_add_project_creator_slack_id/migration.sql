-- Add Project.creatorSlackId (Slack User ID of the project creator).
-- When set, parallel approval requests are sent to the creator's Slack DM
-- instead of the shared SLACK_APPROVAL_CHANNEL.
-- Idempotent so it can also be applied directly to an existing (db push) database.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "creatorSlackId" TEXT;
