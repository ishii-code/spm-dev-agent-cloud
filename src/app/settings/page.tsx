// /settings: 認証必須。アカウント情報 + パスワード変更 + Slack ID 動作確認（オンボーディング）。
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireAuth();
  // Slack ID と動作確認状態は session(JWT) に含まれないので DB から取得。
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { slackId: true, slackIdVerifiedAt: true },
  });
  return (
    <SettingsClient
      session={{
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        mustChangePassword: session.mustChangePassword,
        slackId: user?.slackId ?? null,
        slackIdVerified: user?.slackIdVerifiedAt != null,
      }}
    />
  );
}
