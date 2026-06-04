"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SessionVm = {
  userId: number;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
  mustChangePassword: boolean;
  slackId: string | null;
  slackIdVerified: boolean;
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

  // Slack ID 動作確認（Phase3.2）
  const [slackId, setSlackId] = useState(session.slackId ?? "");
  const [slackVerified, setSlackVerified] = useState(session.slackIdVerified);
  const [slackMsg, setSlackMsg] = useState<string | null>(null);
  const [slackErr, setSlackErr] = useState<string | null>(null);
  const [slackLoading, setSlackLoading] = useState(false);

  // オンボーディング完了条件：本PW設定済み AND Slack ID 動作確認済み。
  const pwDone = !session.mustChangePassword || success;
  const onboardingComplete = pwDone && slackVerified;
  const onboardingNeeded = session.mustChangePassword || !session.slackIdVerified;

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

  async function handleSlackVerify(e: React.FormEvent) {
    e.preventDefault();
    setSlackMsg(null);
    setSlackErr(null);
    setSlackLoading(true);
    const res = await fetch("/api/auth/slack-id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slackId: slackId.trim() }),
    });
    setSlackLoading(false);
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      verified?: boolean;
      displayName?: string | null;
    };
    if (!res.ok) {
      setSlackVerified(false);
      setSlackErr(body.message ?? "Slack ID の動作確認に失敗しました");
      return;
    }
    setSlackVerified(true);
    setSlackMsg(body.displayName ? `動作確認OK：${body.displayName}` : "動作確認OK");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h2 className="text-2xl font-semibold text-slate-900">設定</h2>

      {/* 初回オンボーディング：本PW変更＋Slack ID 動作確認の両方が完了するまで促す（ブロッキング） */}
      {onboardingNeeded && !onboardingComplete && (
        <div className="rounded-lg border-2 border-orange-400 bg-orange-50 p-4 text-sm text-orange-900">
          <p className="text-base font-semibold">初回セットアップを完了してください</p>
          <p className="mt-1">プロジェクト作成には、次の2つの完了が必要です。</p>
          <ul className="mt-2 space-y-1">
            <li>{pwDone ? "✅" : "⬜️"} ① 本パスワードの設定</li>
            <li>{slackVerified ? "✅" : "⬜️"} ② Slack ID の登録と動作確認</li>
          </ul>
          <p className="mt-2 text-xs">両方が ✅ になるまで、プロジェクト作成はブロックされます。</p>
        </div>
      )}
      {onboardingNeeded && onboardingComplete && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
          ✅ 初回セットアップが完了しました。プロジェクトを作成できます。
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
        <h3 className="mb-3 text-sm font-semibold text-slate-900">
          ① パスワード変更 {pwDone && <span className="text-emerald-600">✅</span>}
        </h3>
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

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">
          ② Slack ID（動作確認必須） {slackVerified && <span className="text-emerald-600">✅</span>}
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          通知・承認のメンション先です。Slack のプロフィール →「メンバーID をコピー」で取得できる
          U… / W… 形式のIDを入力し、「動作確認して保存」を押してください。実在するSlackユーザーに
          解決できた場合のみ保存されます。
        </p>
        <form onSubmit={handleSlackVerify} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">Slack メンバーID</label>
            <input
              type="text"
              value={slackId}
              onChange={(e) => {
                setSlackId(e.target.value);
                setSlackVerified(false);
                setSlackMsg(null);
              }}
              placeholder="U0XXXXXXXXX"
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            />
          </div>
          {slackErr && <p className="text-xs text-red-600">{slackErr}</p>}
          {slackMsg && <p className="text-xs text-emerald-700">{slackMsg}</p>}
          <button
            type="submit"
            disabled={slackLoading || !slackId.trim()}
            className="rounded bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {slackLoading ? "確認中..." : "動作確認して保存"}
          </button>
        </form>
      </section>
    </div>
  );
}
