// Slack ID の「動作確認」＝users.info で実在ユーザーに解決できるか（Phase3.2-a）。
// resolveSlackUser は fetcher を注入する純関数（テストは users.info をモック）。
// 本番は makeUsersInfoFetcher(token) を渡す。token は users:read scope が必要。
import { isValidSlackMemberId } from "./slack-mention";

export type ResolveReason = "invalid_format" | "missing_scope" | "user_not_found" | "fetch_failed";

export interface SlackUserResolution {
  ok: boolean;
  reason?: ResolveReason;
  displayName?: string; // profile.display_name（無ければ real_name）
  realName?: string;
}

export interface UsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } };
}

export type UsersInfoFetcher = (slackId: string) => Promise<UsersInfoResponse>;

// 形式検証 → users.info 解決。ok の時だけ ok:true＋表示名を返す。解決不可は reason 付き。
export async function resolveSlackUser(
  slackId: string,
  fetcher: UsersInfoFetcher,
): Promise<SlackUserResolution> {
  const id = (slackId ?? "").trim();
  if (!isValidSlackMemberId(id)) return { ok: false, reason: "invalid_format" };
  let res: UsersInfoResponse;
  try {
    res = await fetcher(id);
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }
  if (res.ok && res.user) {
    const profile = res.user.profile ?? {};
    const displayName = (profile.display_name || profile.real_name || res.user.real_name || "").trim();
    return { ok: true, displayName: displayName || undefined, realName: (res.user.real_name || "").trim() || undefined };
  }
  if (res.error === "missing_scope") return { ok: false, reason: "missing_scope" };
  if (res.error === "user_not_found") return { ok: false, reason: "user_not_found" };
  return { ok: false, reason: "fetch_failed" };
}

// 本番 fetcher：Slack users.info を bot token で呼ぶ（users:read scope 必須）。
export function makeUsersInfoFetcher(token: string | undefined): UsersInfoFetcher {
  return async (slackId: string): Promise<UsersInfoResponse> => {
    if (!token) return { ok: false, error: "fetch_failed" };
    const r = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()) as UsersInfoResponse;
  };
}

// reason → ユーザー向け説明文。
export function resolveReasonText(reason: ResolveReason): string {
  switch (reason) {
    case "invalid_format":
      return "Slack メンバーID の形式が不正です（U… / W… 形式）";
    case "missing_scope":
      return "Slack App に users:read 権限がないため確認できません（管理者に scope 追加を依頼してください）";
    case "user_not_found":
      return "実在の Slack ユーザーに解決できませんでした。IDをご確認ください";
    case "fetch_failed":
      return "Slack への確認に失敗しました。時間をおいて再度お試しください";
  }
}
