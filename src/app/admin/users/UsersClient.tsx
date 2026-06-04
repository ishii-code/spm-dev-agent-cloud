"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isValidSlackMemberId } from "@/lib/slack-mention";

type UserRow = {
  id: number;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  slackId: string | null;
};

const ERROR_MESSAGES: Record<string, string> = {
  email_taken: "このメールアドレスは既に登録されています",
  invalid_email: "メールアドレスの形式が正しくありません",
  name_required: "表示名を入力してください",
  invalid_body: "入力内容が不正です",
  cannot_delete_self: "自分自身は削除できません",
  delete_failed: "削除できませんでした（関連データがある可能性）",
  not_found: "ユーザーが見つかりません",
};

function fmt(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export function UsersClient({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: number;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", name: "", role: "USER" as "USER" | "ADMIN" });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tempPasswordNotice, setTempPasswordNotice] = useState<{ email: string; password: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createForm),
    });
    setCreating(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setCreateError(ERROR_MESSAGES[body.error ?? ""] ?? "作成に失敗しました");
      return;
    }
    const data = (await res.json()) as { user: UserRow; tempPassword: string };
    setShowCreate(false);
    setCreateForm({ email: "", name: "", role: "USER" });
    setTempPasswordNotice({ email: data.user.email, password: data.tempPassword });
    router.refresh();
  }

  async function handleDelete(user: UserRow) {
    if (!confirm(`${user.name}（${user.email}）を削除します。よろしいですか？`)) return;
    setBusyId(user.id);
    const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    setBusyId(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(ERROR_MESSAGES[body.error ?? ""] ?? "削除に失敗しました");
      return;
    }
    router.refresh();
  }

  async function handleReset(user: UserRow) {
    if (!confirm(`${user.name} のパスワードをリセットします。`)) return;
    setBusyId(user.id);
    const res = await fetch(`/api/admin/users/${user.id}/reset-password`, { method: "POST" });
    setBusyId(null);
    if (!res.ok) {
      alert("パスワードリセットに失敗しました");
      return;
    }
    const data = (await res.json()) as { tempPassword: string };
    setTempPasswordNotice({ email: user.email, password: data.tempPassword });
    router.refresh();
  }

  // Slack メンバーID（U…/W…形式）の設定/編集。空入力で解除。@ハンドル・表示名は不可。
  async function handleEditSlackId(user: UserRow) {
    const cur = user.slackId ?? "";
    const input = window.prompt(
      `${user.name} の Slack メンバーID を入力（U… / W… 形式。@ハンドルや表示名は不可。空で解除）`,
      cur,
    );
    if (input === null) return; // キャンセル
    const v = input.trim();
    if (v !== "" && !isValidSlackMemberId(v)) {
      alert("形式が不正です。Slack の『メンバーID』（U または W で始まる英数字。例 U0XXXXXXX）を入力してください。@ハンドルや表示名ではありません。");
      return;
    }
    setBusyId(user.id);
    const res = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackId: v === "" ? null : v }),
    });
    setBusyId(null);
    if (!res.ok) {
      alert("Slack ID の更新に失敗しました");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">アカウント管理</h2>
          <p className="text-sm text-slate-500">登録ユーザー: {users.length} 件</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
        >
          新規アカウント発行
        </button>
      </div>

      {tempPasswordNotice && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <p className="font-medium text-emerald-800">
            {tempPasswordNotice.email} の仮パスワード（一度だけ表示）
          </p>
          <code className="mt-1 block break-all font-mono text-base text-emerald-900">
            {tempPasswordNotice.password}
          </code>
          <button
            type="button"
            onClick={() => setTempPasswordNotice(null)}
            className="mt-2 text-xs text-emerald-700 underline"
          >
            閉じる
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">名前</th>
              <th className="px-3 py-2 text-left">メール</th>
              <th className="px-3 py-2 text-left">権限</th>
              <th className="px-3 py-2 text-left">作成日</th>
              <th className="px-3 py-2 text-left">最終ログイン</th>
              <th className="px-3 py-2 text-left">Slack ID</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  {u.name}
                  {u.mustChangePassword && (
                    <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 text-[10px] text-yellow-800">
                      仮PW
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{u.email}</td>
                <td className="px-3 py-2">{u.role}</td>
                <td className="px-3 py-2 text-slate-500">{fmt(u.createdAt)}</td>
                <td className="px-3 py-2 text-slate-500">{fmt(u.lastLoginAt)}</td>
                <td className="px-3 py-2 text-slate-600">
                  <span className="font-mono text-xs">{u.slackId ?? "—"}</span>
                  <button
                    type="button"
                    onClick={() => handleEditSlackId(u)}
                    disabled={busyId === u.id}
                    className="ml-2 text-xs text-blue-600 hover:underline disabled:opacity-50"
                  >
                    {u.slackId ? "編集" : "設定"}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => handleReset(u)}
                    disabled={busyId === u.id}
                    className="mr-2 text-xs text-orange-700 hover:underline disabled:opacity-50"
                  >
                    PWリセット
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(u)}
                    disabled={busyId === u.id || u.id === currentUserId}
                    className="text-xs text-red-600 hover:underline disabled:opacity-30"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h3 className="mb-3 text-lg font-semibold">新規アカウント発行</h3>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">メールアドレス</label>
                <input
                  type="email"
                  required
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">表示名</label>
                <input
                  type="text"
                  required
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">権限</label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "USER" | "ADMIN" })}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
              {createError && <p className="text-xs text-red-600">{createError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateError(null);
                  }}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={creating || !createForm.email || !createForm.name}
                  className="rounded bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  {creating ? "作成中..." : "発行"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
