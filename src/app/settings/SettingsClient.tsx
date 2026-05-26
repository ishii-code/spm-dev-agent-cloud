"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SessionVm = {
  userId: number;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
  mustChangePassword: boolean;
};

const ERROR_MESSAGES: Record<string, string> = {
  password_too_short: "パスワードは8文字以上にしてください",
  password_mismatch: "新パスワードと確認が一致しません",
  current_password_wrong: "現在のパスワードが正しくありません",
  invalid_body: "入力内容が不正です",
  unauthorized: "セッションが切れました。再ログインしてください。",
};

export function SettingsClient({ session }: { session: SessionVm }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    });
    setLoading(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_MESSAGES[body.error ?? ""] ?? "変更に失敗しました");
      return;
    }
    setSuccess(true);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h2 className="text-2xl font-semibold text-slate-900">設定</h2>

      {session.mustChangePassword && !success && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">仮パスワードが設定されています。</p>
          <p className="mt-1">今すぐ新しいパスワードに変更してください。</p>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">アカウント情報</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex">
            <dt className="w-24 text-slate-500">名前</dt>
            <dd className="text-slate-900">{session.name}</dd>
          </div>
          <div className="flex">
            <dt className="w-24 text-slate-500">メール</dt>
            <dd className="text-slate-900">{session.email}</dd>
          </div>
          <div className="flex">
            <dt className="w-24 text-slate-500">権限</dt>
            <dd className="text-slate-900">{session.role}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">パスワード変更</h3>
        {success && (
          <p className="mb-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            パスワードを変更しました。
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">現在のパスワード</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">新しいパスワード（8文字以上）</label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">新しいパスワード（確認）</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={
              loading ||
              !currentPassword ||
              newPassword.length < 8 ||
              newPassword !== confirmPassword
            }
            className="rounded bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {loading ? "変更中..." : "パスワードを変更"}
          </button>
        </form>
      </section>
    </div>
  );
}
