// /login: セッション有りなら / にリダイレクト、無ければログインフォーム表示
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/");
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">spm-dev-agent</h1>
        <p className="mb-4 text-xs text-slate-500">クラウド版 — 社内ログイン</p>
        <LoginForm />
      </div>
    </div>
  );
}
