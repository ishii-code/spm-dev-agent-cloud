import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export const anthropic = new Anthropic({
  apiKey: apiKey ?? "",
});

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}

// AI 呼び出しエラー（Anthropic / OpenAI 共通）を、原因が分かるユーザー向け日本語に変換する。
// 認証 / 残高・上限 / モデル名 / ネットワーク を判別。詳細は呼び出し側で console.error すること。
export function describeAiError(e: unknown): string {
  const err = e as {
    status?: number;
    message?: string;
    code?: string;
    error?: { type?: string; message?: string };
  };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const type = err?.error?.type ?? "";
  const raw = String(err?.message ?? err?.error?.message ?? e ?? "");
  const hay = `${raw} ${type}`.toLowerCase();

  if (status === 401 || /authentication|invalid api key|invalid x-api-key|unauthorized/.test(hay)) {
    return "設定エラー：APIキーを確認してください（認証に失敗しました）";
  }
  if (
    status === 429 ||
    /insufficient_quota|quota|credit balance|billing|rate.?limit/.test(hay)
  ) {
    return "AIの利用上限または残高不足です。請求・残高設定を確認してください";
  }
  if (status === 404 || /model_not_found|unknown model|model.*(not found|does not exist)/.test(hay)) {
    return "AIモデル設定エラー：モデル名（ANTHROPIC_MODEL / OPENAI_MODEL）を確認してください";
  }
  if (err?.code === "ENOTFOUND" || /econnrefused|etimedout|enetunreach|fetch failed|network/.test(hay)) {
    return "AIサービスに接続できません（ネットワークエラー）。しばらくして再試行してください";
  }
  return raw ? `AI呼び出しエラー：${raw.slice(0, 200)}` : "AI呼び出しに失敗しました";
}
