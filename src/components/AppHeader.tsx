// Server component header. layout.tsx から呼ばれ、セッション有無で表示を切替。
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";

function RoleBadge({ role }: { role: "ADMIN" | "USER" }) {
  if (role === "ADMIN") {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
        管理者
      </span>
    );
  }
  return (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
      ユーザー
    </span>
  );
}

export async function AppHeader() {
  const session = await getSession();
  if (!session) return null;
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5">
        <Link href="/" className="text-sm font-semibold text-slate-900">
          spm-dev-agent
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          {session.role === "ADMIN" && (
            <Link href="/admin/users" className="text-slate-600 hover:text-slate-900">
              アカウント管理
            </Link>
          )}
          <Link href="/settings" className="text-slate-600 hover:text-slate-900">
            設定
          </Link>
          <span className="flex items-center gap-1.5 text-slate-700">
            {session.name}
            <RoleBadge role={session.role} />
          </span>
          <LogoutButton />
        </nav>
      </div>
    </header>
  );
}
