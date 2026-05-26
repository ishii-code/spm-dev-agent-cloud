// /settings: 認証必須。アカウント情報表示 + パスワード変更。
import { requireAuth } from "@/lib/auth";
import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireAuth();
  return (
    <SettingsClient
      session={{
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        mustChangePassword: session.mustChangePassword,
      }}
    />
  );
}
