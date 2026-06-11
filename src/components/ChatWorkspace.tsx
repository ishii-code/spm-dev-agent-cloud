"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAllowedRepo } from "@/lib/repos";
import { decideProjectAccess } from "@/lib/project-access-decision";
import { preferCachedOnLoad, stripPending } from "@/lib/chat-rehydrate";
import { SYSTEMS, NEW_GROUP_LABEL, getSystem } from "@/lib/systems";
import {
  BUSINESS_CATEGORIES,
  DEFAULT_BUSINESS_CATEGORY,
  categoryLabel,
  type BusinessCategoryId,
} from "@/lib/categories";

interface ProjectSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  projectType: string;       // "existing" | "new"
  targetSystem: string | null;
  targetLabel: string | null;
  skipRequirements: boolean;
  isParallel: boolean;
  businessCategory: string;
  sessionStatus?: string;
  isExecuting?: boolean;
  updatedAt: string;
}

const PHASE_ESTIMATES: Record<string, number> = {
  "💬 全体像を把握するため確認します...": 20,
  "💬 エージェントが議論中...": 60,
  "📝 要件定義書を生成中...": 45,
  "📝 設計書を生成中...": 90,
  "💬 回答を踏まえて議論を再開中...": 45,
};

function formatTime(s: number): string {
  if (s <= 0) return "まもなく完了...";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `約${m}分${sec > 0 ? sec + "秒" : ""}` : `約${sec}秒`;
}

function chatStorageKey(projectId: string): string {
  return `chat_messages_${projectId}`;
}

function clearProjectStorage(projectId: string): void {
  try {
    sessionStorage.removeItem(chatStorageKey(projectId));
  } catch {
    // ignore
  }
}

function getProjectStatusBadge(
  project: ProjectSummary,
): { label: string; className: string } | null {
  const status = project.sessionStatus;
  if (project.isExecuting || status === "executing") {
    return {
      label: "⚡ 実行中",
      className: "bg-peco-warning text-white animate-pulse",
    };
  }
  if (status === "requirements_approval") {
    return {
      label: "✋ 承認待ち",
      className:
        "bg-peco-danger-light text-peco-danger border border-peco-danger",
    };
  }
  if (status === "waiting_user") {
    return {
      label: "💬 回答待ち",
      className: "bg-amber-100 text-amber-700 border border-amber-300",
    };
  }
  if (status === "waiting_parallel_confirm") {
    return {
      label: "🔀 確認待ち",
      className:
        "bg-peco-info-light text-peco-info border border-peco-info",
    };
  }
  if (status === "debate") {
    return { label: "💬 議論中", className: "bg-peco-info-light text-peco-info" };
  }
  if (status === "completed") {
    return { label: "✅ 完了", className: "bg-peco-success-light text-peco-success" };
  }
  return null;
}

interface ChatMessage {
  id: string;
  role: "user" | "orchestrator" | "agent1" | "agent2" | "agent3";
  content: string;
  pending?: boolean;
}

interface DocumentEntry {
  id: string;
  type: string;
  title: string;
  content: string;
  obsidianPath: string | null;
  updatedAt: string;
}

interface ProjectDetail {
  project: {
    id: string;
    title: string;
    description: string | null;
    ownerId: number | null;
    targetSystem: string | null;
    targetLabel: string | null;
    sessions: {
      id: string;
      status: string;
      messages: { id: string; role: string; content: string }[];
    }[];
    documents: DocumentEntry[];
  };
  currentSessionStatus?: string;
}

type AgentStatus = "idle" | "thinking" | "streaming";

interface AgentStatuses {
  orchestrator: AgentStatus;
  agent1: AgentStatus;
  agent2: AgentStatus;
  agent3: AgentStatus;
}

const initialAgentStatuses: AgentStatuses = {
  orchestrator: "idle",
  agent1: "idle",
  agent2: "idle",
  agent3: "idle",
};

const BTN_PRIMARY =
  "inline-flex items-center justify-center bg-peco-primary text-peco-gray-900 hover:bg-peco-primary-dark hover:brightness-95 active:brightness-90 rounded-peco-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY =
  "inline-flex items-center justify-center border border-peco-gray-300 text-peco-text-secondary hover:bg-peco-gray-100 hover:brightness-95 active:brightness-90 rounded-peco-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed bg-peco-bg";
const BTN_DANGER =
  "inline-flex items-center justify-center bg-peco-danger text-white hover:opacity-90 hover:brightness-95 active:brightness-90 rounded-peco-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SUCCESS =
  "inline-flex items-center justify-center bg-peco-success text-white hover:opacity-90 hover:brightness-95 active:brightness-90 rounded-peco-md font-medium transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

type PartStatus = "pending" | "running" | "success" | "error" | "skipped";

interface PartInfo {
  partNumber: number;
  title?: string;
  status: PartStatus;
  logs: string[];
}

const STATUS_MAP: Record<string, PartStatus> = {
  waiting: "pending",
  executing: "running",
  completed: "success",
  error: "error",
  skipped: "skipped",
};

function upsertPart(prev: PartInfo[], partNumber: number, patch: Partial<PartInfo>): PartInfo[] {
  const idx = prev.findIndex((p) => p.partNumber === partNumber);
  if (idx >= 0) {
    const cur = prev[idx];
    const next = [...prev];
    next[idx] = { ...cur, ...patch, partNumber };
    return next;
  }
  return [
    ...prev,
    { partNumber, status: "pending", logs: [], ...patch },
  ];
}

export function ChatWorkspace({
  initialProjects,
  initialActiveProjectId,
}: {
  initialProjects: ProjectSummary[];
  // ディープリンク（/projects/[id]）で開いたときに最初に選択するプロジェクト。
  // 指定が無ければ従来どおり先頭（最終更新が最新）を選ぶ。
  initialActiveProjectId?: string;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    (initialActiveProjectId &&
      initialProjects.some((p) => p.id === initialActiveProjectId)
      ? initialActiveProjectId
      : initialProjects[0]?.id) ?? null,
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatuses>(initialAgentStatuses);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [generatingStep, setGeneratingStep] = useState("処理中...");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [executingDocId, setExecutingDocId] = useState<string | null>(null);
  const [executionLog, setExecutionLog] = useState<string[]>([]);
  const [executionStatus, setExecutionStatus] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");
  const [executionExitCode, setExecutionExitCode] = useState<number | null>(null);
  const [parallelSuggestion, setParallelSuggestion] = useState<
    | null
    | { lineCount: number; sprintCount: number; documentId: string; targetRepo: string }
  >(null);
  const [parallelParts, setParallelParts] = useState<PartInfo[]>([]);
  // #4: 実装ボタンのゲート用。parts ポーリングで更新（scaffolding/running/done 等）。
  const [parallelStatus, setParallelStatus] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [activePhaseBadge, setActivePhaseBadge] = useState<{ phase: string; label: string } | null>(null);
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [categoryTarget, setCategoryTarget] = useState<ProjectSummary | null>(null);
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  // Phase2.1 UI 出し分け：現在ユーザ（role/id）と表示中プロジェクトの owner。
  // サーバ認可(requireProjectAccess)が正。ここは表示制御のみ（同じ decideProjectAccess を再利用）。
  const [currentUser, setCurrentUser] = useState<{ id: number; role: "ADMIN" | "USER" } | null>(null);
  const [projectOwnerId, setProjectOwnerId] = useState<number | null>(null);

  // 現在ユーザを一度取得（未ログイン/取得失敗時は null＝制御せず素通し。実体はサーバが 403）。
  useEffect(() => {
    let aborted = false;
    void fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user?: { id: number; role: "ADMIN" | "USER" } | null }) => {
        if (!aborted && d.user) setCurrentUser({ id: d.user.id, role: d.user.role });
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, []);

  // 書込/実行の可否（currentUser 未取得時は true＝UI は素通し、サーバが最終ゲート）。
  const canWrite = useMemo(
    () => (!currentUser ? true : decideProjectAccess(currentUser.role, currentUser.id, projectOwnerId) === "allow"),
    [currentUser, projectOwnerId],
  );
  // useCallback の依存を増やさずに最新 canWrite をハンドラから参照するための ref。
  const canWriteRef = useRef(true);
  useEffect(() => {
    canWriteRef.current = canWrite;
  }, [canWrite]);
  // 最新 isSending を、復帰時エフェクトから stale closure 無しで参照するための ref。
  // 「この tab で実ストリーミング中か」の判定に使う（復帰時の DB 優先 / live 保持の分岐）。
  const isSendingRef = useRef(false);
  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);
  const READONLY_MSG = "他のメンバーの案件のため、実行・編集はできません（閲覧のみ）";

  // 戻り値: 解決した sessionId（無ければ null）。sendMessage 側で
  // activeSessionId が未設定のときの復旧に使うため返す。
  const loadProject = useCallback(async (projectId: string): Promise<string | null> => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) {
        throw new Error(`プロジェクト取得失敗 (${res.status})`);
      }
      const data: ProjectDetail = await res.json();
      const session = data.project.sessions[0];
      const resolvedSessionId = session?.id ?? null;
      setActiveSessionId(resolvedSessionId);
      const resolvedStatus = data.currentSessionStatus ?? session?.status ?? "active";
      setSessionStatus(resolvedStatus);
      setMessages(
        (session?.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role as ChatMessage["role"],
          content: m.content,
        })),
      );
      setDocuments(data.project.documents);
      setProjectOwnerId(data.project.ownerId ?? null);
      if (resolvedStatus === "executing") {
        setExecutionLog([
          "⚡ Claude Codeがバックグラウンドで実行中です",
          "完了するとSlackに通知されます。",
        ]);
        setExecutionStatus("running");
      }
      return resolvedSessionId;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "読み込み失敗");
      return null;
    }
  }, []);

  useEffect(() => {
    setExecutingDocId(null);
    setExecutionLog([]);
    setExecutionStatus("idle");
    setExecutionExitCode(null);
    setSessionStatus("active");
    if (!activeProjectId) {
      setMessages([]);
      setDocuments([]);
      setActiveSessionId(null);
      return;
    }

    // sessionStorage は「初回フラッシュ回避の即時プレースホルダ」として使う。
    // 固まったカーソル(pending)は落として表示（最終的に DB 全文へ置換される）。
    let cachedParsed: ChatMessage[] | null = null;
    try {
      const stored = sessionStorage.getItem(chatStorageKey(activeProjectId));
      if (stored) {
        const parsed = JSON.parse(stored) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedParsed = parsed;
          setMessages(stripPending(parsed));
        }
      }
    } catch {
      // ignore parse errors
    }

    // DB を最終真実源にする：loadProject が完全な保存済み messages を setMessages する。
    // ③表示バグ修正: 旧実装はここで sessionStorage の途中版に必ず戻して DB を捨てていた
    //   （遷移→復帰時に途切れたバブルが残る原因）。復帰時は reader 破棄済み＝非ストリーミング
    //   なので DB を採用する。例外として「この tab で実ストリーミング中」のときだけ
    //   live(cache) を保持し、DB fetch が進行中バブルを消さないようにする（回帰防止）。
    void loadProject(activeProjectId).then(() => {
      if (preferCachedOnLoad(isSendingRef.current, cachedParsed)) {
        setMessages(cachedParsed as ChatMessage[]);
      }
    });
  }, [activeProjectId, loadProject]);

  useEffect(() => {
    if (!activeProjectId || messages.length === 0) return;
    try {
      sessionStorage.setItem(
        chatStorageKey(activeProjectId),
        JSON.stringify(messages),
      );
    } catch {
      // ignore quota errors
    }
  }, [messages, activeProjectId]);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
    };
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!isSending) {
      setElapsedTime(0);
      setEstimatedSeconds(null);
      setRemainingSeconds(null);
      return;
    }
    const timer = setInterval(() => {
      setElapsedTime((t) => t + 1);
      setRemainingSeconds((prev) => (prev !== null && prev > 0 ? prev - 1 : prev === null ? null : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [isSending]);

  useEffect(() => {
    if (executionStatus !== "running" || !activeProjectId) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/projects/${activeProjectId}/logs`);
        if (!r.ok) return;
        const lines = (await r.json()) as string[];
        if (alive && Array.isArray(lines) && lines.length > 0) {
          setExecutionLog(lines);
        }
      } catch {
        // ignore
      }
    };
    void poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [executionStatus, activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${activeProjectId}/parts`);
        if (!res.ok) return;
        type PartRow = {
          partNumber: number | null;
          partTitle: string | null;
          executionStatus: string | null;
        };
        // #4: parts API は {parts, parallelStatus} を返す。旧形式（配列）も後方互換で許容。
        const body = (await res.json()) as
          | PartRow[]
          | { parts: PartRow[]; parallelStatus: string | null };
        if (!alive) return;
        const parts = Array.isArray(body) ? body : body.parts;
        if (!Array.isArray(body)) setParallelStatus(body.parallelStatus);
        if (!Array.isArray(parts) || parts.length === 0) return;
        setParallelParts((prev) => {
          const logsByNum = new Map(prev.map((p) => [p.partNumber, p.logs] as const));
          const titleByNum = new Map(prev.map((p) => [p.partNumber, p.title] as const));
          return parts
            .filter((p) => p.partNumber != null)
            .map<PartInfo>((p) => {
              const num = p.partNumber as number;
              const rawStatus = p.executionStatus ?? "waiting";
              return {
                partNumber: num,
                title: p.partTitle ?? titleByNum.get(num) ?? `Part${num}`,
                status: STATUS_MAP[rawStatus] ?? "pending",
                logs: logsByNum.get(num) ?? [],
              };
            })
            .sort((a, b) => a.partNumber - b.partNumber);
        });
      } catch {
        // ignore
      }
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [activeProjectId]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/projects");
        if (!r.ok) return;
        const data = (await r.json()) as { projects: ProjectSummary[] };
        if (!alive) return;
        setProjects((prev) => {
          // 改善6(a): サーバーを正とみなして同期する。
          //  - サーバーに存在しないプロジェクト（削除済み）はローカルからも除外
          //  - 既存のローカル順序は保ちつつ session 状態を反映
          //  - 別タブ等でサーバーに増えたプロジェクトは末尾に追加
          // ※ 新規作成は POST 完了（DB コミット）後にローカル追加するため、
          //   ここで誤って消えることはない（あっても次 tick で再追加される）。
          const serverMap = new Map(data.projects.map((p) => [p.id, p]));
          const prevIds = new Set(prev.map((p) => p.id));
          const reconciled: ProjectSummary[] = prev
            .filter((p) => serverMap.has(p.id))
            .map((p) => {
              const next = serverMap.get(p.id)!;
              return {
                ...p,
                sessionStatus: next.sessionStatus,
                isExecuting: next.isExecuting,
                isParallel: next.isParallel,
                businessCategory: next.businessCategory ?? p.businessCategory,
              };
            });
          for (const sp of data.projects) {
            if (!prevIds.has(sp.id)) reconciled.push(sp);
          }
          return reconciled;
        });
        // 改善6(b) TODO: サイドバーのステータスバッジ（この /api/projects 由来の
        // sessionStatus）と、メイン画面の状態（SSE / /api/projects/[id] /
        // /api/projects/[id]/parts 由来）が別ソース・別ポーリングのため一時的に
        // ズレることがある。並列実行中は parallelStatus と sessionStatus が乖離する
        // のも一因。恒久対応には状態ソースの一元化（単一フェッチャ＋共有 store）が
        // 必要で影響範囲が広いため、本フェーズでは未対応。
      } catch {
        // ignore
      }
    };
    const id = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (isAtBottom && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, isAtBottom]);

  const createProject = useCallback(
    async (input: {
      title: string;
      description: string;
      projectType: "existing" | "new";
      targetSystem: string | null;
      skipRequirements: boolean;
      businessCategory: BusinessCategoryId;
    }) => {
      try {
        const sys = input.targetSystem ? getSystem(input.targetSystem) : null;
        const res = await fetch("/api/projects", {
          method: "POST",
          // 同一オリジンのため cookie は既定で送信されるが、明示して意図を残す。
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: input.title.trim(),
            description: input.description.trim() || null,
            projectType: input.projectType,
            targetSystem: input.projectType === "existing" ? input.targetSystem : input.targetSystem,
            targetLabel: input.projectType === "existing" ? (sys?.shortLabel ?? null) : null,
            skipRequirements: input.skipRequirements,
            businessCategory: input.businessCategory,
          }),
        });
        console.log(`[CLIENT] /api/projects(作成) 応答 status=${res.status}`);
        // 未ログイン（セッション切れ）は 401。ログイン画面へ誘導して戻ってこられるようにする。
        if (res.status === 401) {
          console.error("[CLIENT] プロジェクト作成 401 unauthorized → /login へ誘導");
          if (typeof window !== "undefined") {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login?next=${next}`;
          }
          return;
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`プロジェクト作成失敗 (${res.status}) ${detail.slice(0, 200)}`);
        }
        const { project } = await res.json();
        setProjects((prev) => [
          {
            id: project.id,
            title: project.title,
            description: project.description,
            status: project.status,
            projectType: project.projectType,
            targetSystem: project.targetSystem,
            targetLabel: project.targetLabel,
            skipRequirements: project.skipRequirements ?? false,
            isParallel: project.isParallel ?? false,
            businessCategory: project.businessCategory ?? DEFAULT_BUSINESS_CATEGORY,
            updatedAt: project.updatedAt ?? new Date().toISOString(),
          },
          ...prev,
        ]);
        setActiveProjectId(project.id);
        setCreateModalOpen(false);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "作成失敗");
      }
    },
    [],
  );

  const sendMessage = useCallback(async (overrideContent?: string) => {
    if (!canWriteRef.current) { setErrorMessage(READONLY_MSG); return; }
    const trimmed = (overrideContent ?? input).trim();
    // 入力なし / プロジェクト未選択 / 送信中 は正当な no-op。
    // ※ activeSessionId はここで弾かず下で確保する（従来は null だと無言で
    //   return し、fetch が一切発火しない＝Orchestrator 無応答の原因だった）。
    if (!trimmed || !activeProjectId || isSending) return;

    // セッション ID を確保する。未設定（取得前 / セッション欠落 / 旧データ）の場合は
    // プロジェクトを再取得して確保を試み、それでも取れなければ画面にエラーを出す。
    let sessionId = activeSessionId;
    if (!sessionId) {
      console.warn(
        `[CLIENT] activeSessionId 未設定。プロジェクト再取得でセッション確保を試みます projectId=${activeProjectId}`,
      );
      sessionId = await loadProject(activeProjectId);
    }
    if (!sessionId) {
      console.error(
        `[CLIENT] セッション取得失敗。送信を中止します projectId=${activeProjectId}`,
      );
      setErrorMessage(
        "セッションを取得できませんでした。ページを再読み込みしてから再度お試しください。",
      );
      return;
    }

    // 最初のユーザー発話なら、保存済みの session storage をクリアしてリセット直後の混在を防ぐ
    const isFirstMessage =
      messages.length === 0 || messages.every((m) => m.role === "user");
    if (isFirstMessage) {
      clearProjectStorage(activeProjectId);
    }

    setIsSending(true);
    setErrorMessage(null);
    setExecutionLog([]);
    setExecutionStatus("idle");
    setExecutionExitCode(null);
    if (overrideContent === undefined) {
      setInput("");
    }

    const localUserId = `u-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: localUserId, role: "user", content: trimmed },
    ]);

    setAgentStatuses({ ...initialAgentStatuses, orchestrator: "thinking" });

    const buffers: Partial<Record<ChatMessage["role"], string>> = {};
    const placeholderIds: Partial<Record<ChatMessage["role"], string>> = {};

    const ensurePlaceholder = (role: ChatMessage["role"]) => {
      if (placeholderIds[role]) return;
      const id = `p-${role}-${Date.now()}`;
      placeholderIds[role] = id;
      buffers[role] = "";
      setMessages((prev) => [
        ...prev,
        { id, role, content: "", pending: true },
      ]);
    };

    const appendChunk = (role: ChatMessage["role"], chunk: string) => {
      ensurePlaceholder(role);
      buffers[role] = (buffers[role] ?? "") + chunk;
      const id = placeholderIds[role];
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: buffers[role] ?? "" } : m)),
      );
    };

    try {
      console.log(
        `[CLIENT] /api/chat 送信開始 projectId=${activeProjectId} sessionId=${sessionId} msgLen=${trimmed.length}`,
      );
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          projectId: activeProjectId,
          message: trimmed,
        }),
      });
      console.log(`[CLIENT] /api/chat 応答 status=${res.status}`);
      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => "");
        console.error(
          `[CLIENT] /api/chat 失敗 status=${res.status} body=${errBody.slice(0, 300)}`,
        );
        throw new Error(
          `送信失敗 (${res.status})${errBody ? " " + errBody.slice(0, 200) : ""}`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx = buf.indexOf("\n\n");
        while (idx !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = raw
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              const payload = JSON.parse(dataLine.slice(6));
              handleSSE(payload);
            } catch {
              // skip malformed
            }
          }
          idx = buf.indexOf("\n\n");
        }
      }

      function handleSSE(payload: { type: string; data: unknown }) {
        if (payload.type === "text") {
          const { agent, chunk } = payload.data as { agent: ChatMessage["role"]; chunk: string };
          setAgentStatuses((prev) => ({ ...prev, [agent]: "streaming" }));
          appendChunk(agent, chunk);
          const labels: Record<string, string> = {
            orchestrator: "🤖 Orchestratorが発言中",
            agent1: "🔍 Agent1（要件）が発言中",
            agent2: "📋 Agent2（設計）が発言中",
            agent3: "✅ Agent3（QA）が発言中",
          };
          if (labels[agent]) setGeneratingStep(labels[agent]);
        } else if (payload.type === "agent") {
          const { agent, status } = payload.data as {
            agent: keyof AgentStatuses;
            status: AgentStatus;
          };
          setAgentStatuses((prev) => ({ ...prev, [agent]: status }));
          if (status === "streaming") {
            // 新しいターン: そのエージェントの placeholder をクリア → 次の text で新規バブルが作られる
            delete placeholderIds[agent as ChatMessage["role"]];
            delete buffers[agent as ChatMessage["role"]];
          }
        } else if (payload.type === "agent_start") {
          const { agentType } = payload.data as { agentType: string };
          const key = agentTypeToKey(agentType);
          if (key) {
            setAgentStatuses((prev) => ({ ...prev, [key]: "thinking" }));
            delete placeholderIds[key as ChatMessage["role"]];
            delete buffers[key as ChatMessage["role"]];
          }
          if (agentType === "debate") {
            // ラウンド開始: 全エージェントの placeholder をクリア
            for (const k of ["orchestrator", "agent1", "agent2", "agent3"] as const) {
              delete placeholderIds[k];
              delete buffers[k];
            }
          }
        } else if (payload.type === "agent_complete") {
          const { agentType } = payload.data as { agentType: string };
          const key = agentTypeToKey(agentType);
          if (key) setAgentStatuses((prev) => ({ ...prev, [key]: "idle" }));
        } else if (payload.type === "document") {
          const doc = payload.data as DocumentEntry;
          setDocuments((prev) => [doc, ...prev]);
        } else if (payload.type === "done") {
          setAgentStatuses(initialAgentStatuses);
        } else if (payload.type === "phase_start") {
          const { phase, label } = payload.data as { phase: string; label: string };
          const safeLabel = label ?? "処理中...";
          setActivePhaseBadge({ phase, label: safeLabel });
          setGeneratingStep(safeLabel);
          setElapsedTime(0);
          const est = PHASE_ESTIMATES[safeLabel] ?? 60;
          setEstimatedSeconds(est);
          setRemainingSeconds(est);
          // フェーズ転換: 全 placeholder をクリア → 次の text で新規バブル
          for (const k of ["orchestrator", "agent1", "agent2", "agent3"] as const) {
            delete placeholderIds[k];
            delete buffers[k];
          }
        } else if (payload.type === "phase_complete") {
          const { phase } = payload.data as { phase: string };
          setSessionStatus(phase);
          setActivePhaseBadge(null);
        } else if (payload.type === "error") {
          const data = payload.data as { message: string };
          setErrorMessage(data.message);
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "送信失敗");
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.pending ? { ...m, pending: false } : m)),
      );
      setIsSending(false);
      setAgentStatuses(initialAgentStatuses);
      setActivePhaseBadge(null);
      // #4: 生成完了後にサーバ状態を再同期（documents→設計書ボタン有効化、sessionStatus→バッジ解除）。
      if (activeProjectId) void loadProject(activeProjectId);
    }
  }, [input, activeProjectId, activeSessionId, isSending, loadProject]);

  const handleCancelDebate = useCallback(async () => {
    if (!activeProjectId || !activeSessionId) return;
    const ok = window.confirm("これまでの議論内容を全て削除して最初からやり直しますか？");
    if (!ok) return;
    try {
      await fetch(`/api/sessions/${activeSessionId}/reset`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
    } catch {
      // ignore network error; UI 側はリセット続行
    }
    clearProjectStorage(activeProjectId);
    setMessages([]);
    setDocuments([]);
    setSessionStatus("initial_interview");
    setExecutionLog([]);
    setExecutionStatus("idle");
    setParallelSuggestion(null);
    setParallelParts([]);
  }, [activeProjectId, activeSessionId]);

  const runExecute = useCallback(
    async (documentId: string, targetRepo: string, force = false) => {
      if (!canWriteRef.current) { setErrorMessage(READONLY_MSG); return; }
      if (!activeProjectId || executingDocId) return;
      // #4: scaffold/実行中の二重 execute を防止する再発火ガード。
      if (["scaffolding", "scaffolding_active", "running"].includes(parallelStatus ?? "")) return;
      setExecutingDocId(documentId);
      setExecutionLog([]);
      setExecutionStatus("running");
      setExecutionExitCode(null);
      setParallelSuggestion(null);
      setParallelParts([]);

      const appendLogLines = (raw: string) => {
        const parts = raw.split(/\r?\n/);
        // 末尾の空文字（trailing newline 由来）は捨てる
        if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
        if (parts.length === 0) return;
        setExecutionLog((prev) => [...prev, ...parts]);
      };

      try {
        const res = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId,
            projectId: activeProjectId,
            targetRepo,
            force,
          }),
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(`実行失敗 (${res.status}) ${text.slice(0, 200)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finalStatus: "success" | "error" | null = null;
        let suggestionReceived = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let idx = buf.indexOf("\n\n");
          while (idx !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              try {
                const payload = JSON.parse(dataLine.slice(6));
                if (payload.type === "execute_log") {
                  const { line } = payload.data as { line: string };
                  appendLogLines(line);
                } else if (payload.type === "execute_done") {
                  const data = payload.data as {
                    success: boolean;
                    exitCode: number | null;
                  };
                  finalStatus = data.success ? "success" : "error";
                  setExecutionExitCode(data.exitCode);
                } else if (payload.type === "parallel_suggestion") {
                  const d = payload.data as {
                    lineCount: number;
                    sprintCount: number;
                    documentId: string;
                    targetRepo: string;
                  };
                  setParallelSuggestion({
                    lineCount: d.lineCount,
                    sprintCount: d.sprintCount,
                    documentId: d.documentId,
                    targetRepo: d.targetRepo,
                  });
                  suggestionReceived = true;
                } else if (payload.type === "parallel_part_status") {
                  const d = payload.data as {
                    partNumber: number;
                    title?: string;
                    status: PartStatus;
                  };
                  setParallelParts((prev) =>
                    upsertPart(prev, d.partNumber, {
                      title: d.title,
                      status: d.status,
                    }),
                  );
                } else if (payload.type === "parallel_part_log") {
                  const d = payload.data as { partNumber: number; line: string };
                  setParallelParts((prev) => {
                    const cur = prev.find((p) => p.partNumber === d.partNumber);
                    const nextLogs = [...(cur?.logs ?? []), d.line].slice(-50);
                    return upsertPart(prev, d.partNumber, { logs: nextLogs });
                  });
                  appendLogLines(d.line);
                } else if (payload.type === "error") {
                  const data = payload.data as { message: string };
                  setErrorMessage(data.message);
                  finalStatus = "error";
                }
              } catch {
                // skip malformed
              }
            }
            idx = buf.indexOf("\n\n");
          }
        }
        if (suggestionReceived) {
          setExecutionStatus("idle");
        } else {
          setExecutionStatus(finalStatus ?? "error");
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "実行失敗");
        setExecutionStatus("error");
      } finally {
        setExecutingDocId(null);
        // #4: 実行/並列開始の完了後にサーバ状態を再同期（parts/parallelStatus/documents）。
        if (activeProjectId) void loadProject(activeProjectId);
      }
    },
    [activeProjectId, executingDocId, loadProject, parallelStatus],
  );

  const runParallelExecute = useCallback(
    async (documentId: string, targetRepo: string) => {
      if (!canWriteRef.current) { setErrorMessage(READONLY_MSG); return; }
      if (!activeProjectId || executingDocId) return;
      // #4: scaffold/実行中の二重 execute を防止する再発火ガード。
      if (["scaffolding", "scaffolding_active", "running"].includes(parallelStatus ?? "")) return;
      setExecutingDocId(documentId);
      setExecutionLog([]);
      setExecutionStatus("running");
      setExecutionExitCode(null);
      setParallelSuggestion(null);
      setParallelParts([]);

      const appendLogLines = (raw: string) => {
        const parts = raw.split(/\r?\n/);
        if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
        if (parts.length === 0) return;
        setExecutionLog((prev) => [...prev, ...parts]);
      };

      try {
        const res = await fetch("/api/execute/parallel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId, projectId: activeProjectId, targetRepo }),
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(`並列実行失敗 (${res.status}) ${text.slice(0, 200)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finalStatus: "success" | "error" | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              try {
                const payload = JSON.parse(dataLine.slice(6));
                if (payload.type === "execute_log") {
                  appendLogLines((payload.data as { line: string }).line);
                } else if (payload.type === "parallel_part_status") {
                  const d = payload.data as {
                    partNumber: number;
                    title?: string;
                    status: PartStatus;
                  };
                  setParallelParts((prev) =>
                    upsertPart(prev, d.partNumber, {
                      title: d.title,
                      status: d.status,
                    }),
                  );
                } else if (payload.type === "parallel_part_log") {
                  const d = payload.data as { partNumber: number; line: string };
                  setParallelParts((prev) => {
                    const cur = prev.find((p) => p.partNumber === d.partNumber);
                    const nextLogs = [...(cur?.logs ?? []), d.line].slice(-50);
                    return upsertPart(prev, d.partNumber, { logs: nextLogs });
                  });
                  appendLogLines(d.line);
                } else if (payload.type === "execute_done") {
                  const data = payload.data as { success: boolean };
                  finalStatus = data.success ? "success" : "error";
                } else if (payload.type === "error") {
                  setErrorMessage((payload.data as { message: string }).message);
                  finalStatus = "error";
                }
              } catch {
                // skip malformed
              }
            }
            idx = buf.indexOf("\n\n");
          }
        }
        setExecutionStatus(finalStatus ?? "error");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "並列実行失敗");
        setExecutionStatus("error");
      } finally {
        setExecutingDocId(null);
        // #4: 実行/並列開始の完了後にサーバ状態を再同期（parts/parallelStatus/documents）。
        if (activeProjectId) void loadProject(activeProjectId);
      }
    },
    [activeProjectId, executingDocId, loadProject, parallelStatus],
  );

  const latestSprintDoc = useMemo(
    () => {
      const sprintDocs = documents.filter((d) => d.type === "sprint");
      return sprintDocs
        .slice()
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
    },
    [documents],
  );

  const latestRequirementsDoc = useMemo(
    () => {
      const docs = documents.filter((d) => d.type === "requirements");
      return docs
        .slice()
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
    },
    [documents],
  );

  const isSprintReady = useMemo(() => {
    if (!latestSprintDoc) return false;
    if (!latestSprintDoc.content || latestSprintDoc.content.length < 1500) return false;
    return true;
  }, [latestSprintDoc]);

  const groupedProjects = useMemo(() => groupProjects(projects), [projects]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const startEditProject = useCallback((project: ProjectSummary) => {
    setEditingProjectId(project.id);
    setEditingTitle(project.title);
  }, []);

  const cancelEditProject = useCallback(() => {
    setEditingProjectId(null);
    setEditingTitle("");
  }, []);

  const saveEditProject = useCallback(async () => {
    if (!editingProjectId) return;
    const trimmed = editingTitle.trim();
    if (trimmed.length === 0) {
      cancelEditProject();
      return;
    }
    const originalProject = projects.find((p) => p.id === editingProjectId);
    if (originalProject && originalProject.title === trimmed) {
      cancelEditProject();
      return;
    }
    try {
      const res = await fetch(`/api/projects/${editingProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`タイトル更新失敗 (${res.status}) ${detail.slice(0, 200)}`);
      }
      const { project } = await res.json();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id
            ? {
                ...p,
                title: project.title,
                updatedAt: project.updatedAt ?? p.updatedAt,
              }
            : p,
        ),
      );
      cancelEditProject();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新失敗");
      cancelEditProject();
    }
  }, [editingProjectId, editingTitle, projects, cancelEditProject]);

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const detail = await res.text().catch(() => "");
        throw new Error(`削除失敗 (${res.status}) ${detail.slice(0, 200)}`);
      }
      const deletedId = deleteTarget.id;
      clearProjectStorage(deletedId);
      setProjects((prev) => prev.filter((p) => p.id !== deletedId));
      if (activeProjectId === deletedId) {
        setActiveProjectId(null);
        setMessages([]);
        setDocuments([]);
        setActiveSessionId(null);
      }
      setDeleteTarget(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除失敗");
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, activeProjectId]);

  // 改善8d: 詳細ヘッダーからのアーカイブ（ソフトデリート）。
  // DELETE /api/projects/[id] は archivedAt をセットするだけなので DB 上は残る。
  const handleArchiveActive = useCallback(async () => {
    if (!activeProjectId) return;
    const ok = window.confirm(
      "このプロジェクトをアーカイブしますか?\n（DB上は残るので後で復元可能ですが、UI上は見えなくなります）",
    );
    if (!ok) return;
    const archivedId = activeProjectId;
    try {
      const res = await fetch(`/api/projects/${archivedId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const detail = await res.text().catch(() => "");
        throw new Error(`アーカイブ失敗 (${res.status}) ${detail.slice(0, 200)}`);
      }
      clearProjectStorage(archivedId);
      setProjects((prev) => prev.filter((p) => p.id !== archivedId));
      setActiveProjectId(null);
      setMessages([]);
      setDocuments([]);
      setActiveSessionId(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "アーカイブ失敗");
    }
  }, [activeProjectId]);

  // 改善B: 事業カテゴリの変更（PATCH /api/projects/[id]）。
  const handleSaveCategory = useCallback(
    async (projectId: string, category: BusinessCategoryId) => {
      setIsSavingCategory(true);
      try {
        const res = await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessCategory: category }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`カテゴリ変更失敗 (${res.status}) ${detail.slice(0, 200)}`);
        }
        setProjects((prev) =>
          prev.map((p) => (p.id === projectId ? { ...p, businessCategory: category } : p)),
        );
        setCategoryTarget(null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "カテゴリ変更失敗");
      } finally {
        setIsSavingCategory(false);
      }
    },
    [],
  );

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[280px_1fr_320px]">
      {/* Left Sidebar */}
      <aside className="bg-peco-gray-50 border-r border-peco-gray-300 flex flex-col min-h-0">
        <div className="px-4 pt-3 border-b border-peco-gray-300">
          <Link
            href="/systems"
            className="flex items-center gap-2 px-3 py-2 mb-3 rounded-peco-md border border-peco-gray-300 text-sm text-peco-text-primary hover:bg-peco-gray-100 transition-colors bg-peco-bg"
          >
            <span aria-hidden>🖥️</span>
            <span className="font-medium">システム一覧</span>
          </Link>
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className={`${BTN_PRIMARY} w-full h-12 px-4 mb-4`}
          >
            + 新規プロジェクト
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {projects.length === 0 && (
            <p className="p-4 text-sm text-peco-text-muted">
              プロジェクトがありません
            </p>
          )}
          {groupedProjects.map((group) => {
            const collapsed = !!collapsedGroups[group.key];
            return (
              <section key={group.key} className="border-b border-peco-gray-300">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center justify-between px-4 py-2 bg-peco-gray-100 hover:bg-peco-gray-50 transition-colors"
                  aria-expanded={!collapsed}
                >
                  <span className="text-xs font-semibold text-peco-text-secondary uppercase tracking-wider">
                    【{group.label}】 <span className="text-peco-text-muted normal-case">{group.items.length}</span>
                  </span>
                  <span className="text-xs text-peco-text-muted">{collapsed ? "▸" : "▾"}</span>
                </button>
                {!collapsed && (
                  <ul>
                    {group.items.map((p) => (
                      <ProjectListItem
                        key={p.id}
                        project={p}
                        isActive={p.id === activeProjectId}
                        isEditing={editingProjectId === p.id}
                        editingTitle={editingTitle}
                        onSelect={() => setActiveProjectId(p.id)}
                        onStartEdit={() => startEditProject(p)}
                        onChangeEditingTitle={setEditingTitle}
                        onSaveEdit={() => void saveEditProject()}
                        onCancelEdit={cancelEditProject}
                        onRequestDelete={() => setDeleteTarget(p)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </aside>

      {/* Main Chat */}
      <section className="flex flex-col min-h-0 bg-peco-bg">
        {activeProjectId && (
          <div className="flex items-start justify-between gap-3 px-6 py-2 border-b border-peco-gray-300 bg-peco-bg overflow-x-hidden">
            {(() => {
              const activeProject = projects.find((p) => p.id === activeProjectId);
              return (
                <div className="min-w-0 flex-1">
                  <span
                    className="line-clamp-2 break-words text-base font-semibold text-peco-text-primary"
                    title={activeProject?.title ?? ""}
                  >
                    {activeProject?.title ?? ""}
                  </span>
                  <span className="block mt-0.5 text-xs text-peco-text-muted">
                    {categoryLabel(activeProject?.businessCategory)}
                  </span>
                </div>
              );
            })()}
            <div className="shrink-0 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const ap = projects.find((p) => p.id === activeProjectId);
                  if (ap) setCategoryTarget(ap);
                }}
                className="text-xs text-peco-text-muted hover:text-peco-primary-dark border border-peco-gray-300 rounded-peco-sm px-2 py-1 transition-colors duration-150"
                title="このプロジェクトの事業カテゴリを変更します"
              >
                📂 カテゴリ変更
              </button>
              <button
                type="button"
                onClick={() => void handleArchiveActive()}
                className="text-xs text-peco-text-muted hover:text-peco-danger border border-peco-gray-300 rounded-peco-sm px-2 py-1 transition-colors duration-150"
                title="このプロジェクトをアーカイブ（UI上から非表示にします）"
              >
                🗄️ アーカイブ
              </button>
            </div>
          </div>
        )}
        {errorMessage && (
          <div className="bg-peco-danger-light border-l-4 border-peco-danger text-peco-text-primary px-6 py-3 text-sm peco-fade-in">
            <span className="font-medium">エラー:</span> {errorMessage}
          </div>
        )}

        {!activePhaseBadge && activeProjectId && sessionStatus !== "active" && (
          <div className="px-6 py-2 border-b border-peco-gray-300 bg-peco-bg">
            <StaticPhaseBadge status={sessionStatus} />
          </div>
        )}
        {activePhaseBadge && (
          <div className="px-6 py-2 border-b border-peco-gray-300 bg-peco-bg peco-fade-in">
            <PhaseBadge phase={activePhaseBadge.phase} label={activePhaseBadge.label} />
          </div>
        )}

        {isSending && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-center gap-3 mb-1">
              <span
                className="inline-block w-5 h-5 rounded-full border-2 border-amber-500 border-t-transparent peco-spin"
                aria-hidden
              />
              <span className="text-base font-semibold text-amber-800 flex-1">
                {generatingStep.includes("設計書")
                  ? "📋 設計書を作成中…（最大 1 分程度）"
                  : generatingStep}
              </span>
              {remainingSeconds !== null && (
                <span className="text-xs text-amber-500 tabular-nums shrink-0">
                  残り {formatTime(remainingSeconds)}
                </span>
              )}
            </div>
            <div className="text-xs text-amber-600 mb-1.5 pl-8">
              経過: {elapsedTime}秒 — 処理は進行中です。そのままお待ちください。
            </div>
            {estimatedSeconds !== null && remainingSeconds !== null && (
              <div className="space-y-0.5">
                <div className="w-full bg-amber-200 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-amber-500 h-1.5 rounded-full transition-all duration-1000"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          ((estimatedSeconds - remainingSeconds) /
                            estimatedSeconds) *
                            100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between text-xs text-amber-400">
                  <span>
                    経過: {formatTime(estimatedSeconds - remainingSeconds)}
                  </span>
                  <span>目安: {formatTime(estimatedSeconds)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={chatContainerRef} className="flex-1 overflow-auto px-6 py-6 space-y-5">
          {!activeProjectId && (
            <div className="text-center text-peco-text-muted mt-20">
              左サイドバーからプロジェクトを選ぶか、新規作成してください。
            </div>
          )}
          {activeProjectId && messages.length === 0 && (
            <div className="text-center text-peco-text-muted mt-20">
              依頼を入力してください。Orchestratorが受け取ります。
            </div>
          )}
          {(() => {
            const items = expandMessagesForRender(messages);
            const lastBubbleIdx = (() => {
              for (let i = items.length - 1; i >= 0; i--) {
                if (items[i].type === "bubble") return i;
              }
              return -1;
            })();
            return items.map((item, i) => {
              if (item.type === "divider") {
                return <RoundDivider key={item.key} round={item.round ?? 1} />;
              }
              const role = item.role ?? "orchestrator";
              const isLatest = i === lastBubbleIdx && !item.pending;
              const isOrchestratorOrAgent1 =
                role === "orchestrator" || role === "agent1";
              const showInteractiveForm =
                isLatest && isOrchestratorOrAgent1;
              return (
                <ChatBubble
                  key={item.key}
                  role={role}
                  content={item.content ?? ""}
                  isStreaming={item.pending}
                  showInteractiveForm={showInteractiveForm}
                  onAnswerSubmit={
                    showInteractiveForm
                      ? (answer) => void sendMessage(answer)
                      : undefined
                  }
                />
              );
            });
          })()}
          {latestSprintDoc && (() => {
            const anyPartRunning = parallelParts.some((p) => p.status === "running");
            const isExecuting =
              (executingDocId != null && executingDocId === latestSprintDoc.id) ||
              anyPartRunning;
            if (typeof window !== "undefined") {
              console.log("[ISEXEC]", {
                executingDocId,
                latestSprintDocId: latestSprintDoc.id,
                anyPartRunning,
                partStatuses: parallelParts.map(
                  (p) => `${p.partNumber}:${p.status}`,
                ),
                sessionStatus,
              });
            }
            return (
            <ExecutorPanel
              document={latestSprintDoc}
              projectId={activeProjectId ?? ""}
              sessionId={activeSessionId}
              projectType={
                projects.find((p) => p.id === activeProjectId)?.projectType as "existing" | "new" ?? "existing"
              }
              targetSystem={
                projects.find((p) => p.id === activeProjectId)?.targetSystem ?? null
              }
              targetLabel={
                projects.find((p) => p.id === activeProjectId)?.targetLabel ?? null
              }
              isExecuting={isExecuting}
              isSprintReady={isSprintReady}
              isParallel={
                projects.find((p) => p.id === activeProjectId)?.isParallel ?? false
              }
              sessionStatus={sessionStatus}
              onProjectUpdate={() => {
                if (!activeProjectId) return;
                void fetch(`/api/projects/${activeProjectId}`)
                  .then((r) => r.json())
                  .then((data: ProjectDetail) => {
                    setProjects((prev) =>
                      prev.map((p) =>
                        p.id === activeProjectId
                          ? { ...p, targetSystem: data.project.targetSystem, targetLabel: data.project.targetLabel }
                          : p,
                      ),
                    );
                  });
              }}
              onDocumentUpdated={(updatedContent) => {
                setDocuments((prev) =>
                  prev.map((d) =>
                    d.id === latestSprintDoc.id ? { ...d, content: updatedContent, updatedAt: new Date().toISOString() } : d,
                  ),
                );
              }}
              onResetRequirements={() => {
                setDocuments((prev) => prev.filter((d) => d.type !== "sprint"));
                setExecutionLog([]);
                setExecutionStatus("idle");
              }}
              onResetFull={() => {
                if (activeProjectId) clearProjectStorage(activeProjectId);
                setDocuments([]);
                setMessages([]);
                setExecutionLog([]);
                setExecutionStatus("idle");
                setParallelSuggestion(null);
                setParallelParts([]);
              }}
              executionLog={executionLog}
              executionStatus={executionStatus}
              executionExitCode={executionExitCode}
              parallelSuggestion={parallelSuggestion}
              parallelParts={parallelParts}
              parallelStatus={parallelStatus}
              canWrite={canWrite}
              onExecute={(repo) => void runExecute(latestSprintDoc.id, repo)}
              onForceNormal={(repo) => void runExecute(latestSprintDoc.id, repo, true)}
              onRunParallel={(repo) => void runParallelExecute(latestSprintDoc.id, repo)}
              onClearLogs={async () => {
                if (!activeProjectId) return;
                try {
                  await fetch(`/api/projects/${activeProjectId}/logs`, {
                    method: "DELETE",
                  });
                } catch {
                  // ignore
                }
                setExecutionLog([]);
              }}
            />
            );
          })()}
        </div>

        {sessionStatus === "waiting_user" && (
          <div className="shrink-0 mx-4 mb-2 px-4 py-2 bg-amber-50 border border-amber-300 rounded-peco-md flex items-center gap-2">
            <span className="text-amber-500" aria-hidden>
              💬
            </span>
            <span className="text-sm text-amber-700">
              上の質問に回答して送信してください
            </span>
          </div>
        )}

        {sessionStatus === "requirements_approval" && (
          <div className="shrink-0 mx-4 mb-2 px-4 py-3 bg-peco-success-light border border-peco-success rounded-peco-md">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-peco-success font-medium">
                📋 要件定義書が完成しました
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void sendMessage("A. はい、この要件で設計・実装に進めてください")
                }
                disabled={isSending}
                className="flex-1 py-2 bg-peco-success text-white rounded-peco-md text-sm font-medium hover:brightness-95 active:brightness-90 cursor-pointer transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ✅ この要件で進める
              </button>
              <button
                type="button"
                onClick={() => void sendMessage("B. 修正が必要です")}
                disabled={isSending}
                className="flex-1 py-2 border border-peco-warning text-peco-warning rounded-peco-md text-sm font-medium hover:bg-peco-warning-light cursor-pointer transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ✏️ 修正が必要
              </button>
            </div>
          </div>
        )}

        {(sessionStatus === "waiting_user" ||
          sessionStatus === "debate" ||
          sessionStatus === "initial_interview") &&
          executionStatus !== "running" && (
            <div className="shrink-0 flex justify-end px-4 pb-1">
              <button
                type="button"
                onClick={() => void handleCancelDebate()}
                disabled={isSending}
                className="text-xs text-peco-text-muted hover:text-peco-danger cursor-pointer transition-colors duration-150 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                🗑️ 議論をキャンセル
              </button>
            </div>
          )}

        <div className="border-t border-peco-gray-300 bg-peco-bg p-4">
          {!canWrite && (
            <div className="mb-2 rounded-peco-md bg-peco-gray-100 px-3 py-2 text-sm text-peco-text-muted">
              👁️ 他のメンバーの案件です（閲覧のみ）。実行・編集はオーナーまたは管理者のみ可能です。
            </div>
          )}
          <div className="flex gap-3">
            <textarea
              className="flex-1 min-h-[60px] max-h-40 resize-none rounded-peco-md border border-peco-gray-300 px-3 py-2 text-base text-peco-text-primary placeholder:text-peco-text-muted focus:outline-none focus:border-peco-primary disabled:opacity-50"
              placeholder={
                !canWrite
                  ? "閲覧のみ（他メンバーの案件）"
                  : activeProjectId
                  ? "Orchestratorに依頼を入力（Cmd/Ctrl+Enterで送信）"
                  : "プロジェクトを選択してください"
              }
              value={input}
              disabled={!activeProjectId || isSending || !canWrite}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!activeProjectId || isSending || !input.trim() || !canWrite}
              className={`${BTN_PRIMARY} h-12 self-end px-6`}
            >
              {isSending ? "送信中…" : "送信"}
            </button>
          </div>
        </div>
      </section>

      {/* Right Panel */}
      <aside className="bg-peco-gray-50 border-l border-peco-gray-300 flex flex-col min-h-0">
        <div className="p-4 border-b border-peco-gray-300">
          <h2 className="text-xs font-semibold text-peco-text-muted uppercase tracking-wider">
            エージェント状態
          </h2>
          <div className="mt-3 space-y-2">
            <AgentStatusCard
              label="Orchestrator"
              role="orchestrator"
              status={agentStatuses.orchestrator}
            />
            <AgentStatusCard
              label="Agent1 要件定義"
              role="agent1"
              status={agentStatuses.agent1}
            />
            <AgentStatusCard
              label="Agent2 設計・PM"
              role="agent2"
              status={agentStatuses.agent2}
              placeholder
            />
            <AgentStatusCard
              label="Agent3 QA"
              role="agent3"
              status={agentStatuses.agent3}
              placeholder
            />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <h2 className="text-xs font-semibold text-peco-text-muted uppercase tracking-wider">
            生成ドキュメント
          </h2>
          {documents.length === 0 ? (
            <p className="mt-3 text-xs text-peco-text-muted">
              要件定義書が生成されるとここに表示されます
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="text-sm bg-peco-bg border border-peco-gray-300 rounded-peco-md p-3 peco-fade-in"
                >
                  <div className="font-medium text-peco-text-primary">{d.title}</div>
                  <div className="text-xs text-peco-text-muted mt-0.5">
                    type: {d.type}
                  </div>
                  {d.obsidianPath && (
                    <div className="text-xs text-peco-text-muted mt-1 break-all">
                      📚 {d.obsidianPath}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      {isCreateModalOpen && (
        <CreateProjectModal
          onCancel={() => setCreateModalOpen(false)}
          onCreate={createProject}
        />
      )}
      {deleteTarget && (
        <DeleteProjectModal
          project={deleteTarget}
          isDeleting={isDeleting}
          onCancel={() => !isDeleting && setDeleteTarget(null)}
          onConfirm={() => void confirmDeleteProject()}
        />
      )}
    </div>
  );
}

interface ProjectGroup {
  key: string;
  label: string;
  items: ProjectSummary[];
}

function groupProjects(projects: ProjectSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  // 先頭は「新規アプリ」
  groups.set("new", { key: "new", label: NEW_GROUP_LABEL, items: [] });
  for (const s of SYSTEMS) {
    if (s.id === "other") continue;
    groups.set(s.id, { key: s.id, label: s.shortLabel, items: [] });
  }
  groups.set("other", { key: "other", label: "その他", items: [] });

  for (const p of projects) {
    if (p.projectType === "new") {
      groups.get("new")!.items.push(p);
      continue;
    }
    const key = p.targetSystem && groups.has(p.targetSystem) ? p.targetSystem : "other";
    groups.get(key)!.items.push(p);
  }

  return Array.from(groups.values()).filter((g) => g.items.length > 0);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function ProjectListItem({
  project,
  isActive,
  isEditing,
  editingTitle,
  onSelect,
  onStartEdit,
  onChangeEditingTitle,
  onSaveEdit,
  onCancelEdit,
  onRequestDelete,
}: {
  project: ProjectSummary;
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  onSelect: () => void;
  onStartEdit: () => void;
  onChangeEditingTitle: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onRequestDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        onClick={() => {
          if (!isEditing) onSelect();
        }}
        onKeyDown={(e) => {
          if (isEditing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`group w-full text-left border-b border-peco-gray-300 px-4 py-3 cursor-pointer transition-all duration-150 ${
          isActive
            ? "bg-peco-primary-light border-l-4 border-l-peco-primary"
            : "hover:bg-peco-gray-100 hover:shadow-peco-md"
        }`}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editingTitle}
            maxLength={200}
            onChange={(e) => onChangeEditingTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                onSaveEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
            onBlur={() => onSaveEdit()}
            className="w-full text-sm font-medium px-2 py-1 border border-peco-primary rounded-peco-sm bg-peco-bg text-peco-text-primary focus:outline-none"
          />
        ) : (
          <div
            className="font-medium truncate text-peco-text-primary text-sm cursor-text"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            title={project.title}
          >
            {project.title}
          </div>
        )}

        <div className="mt-1">
          <ProjectBadge project={project} />
        </div>

        {(() => {
          const statusBadge = getProjectStatusBadge(project);
          if (!statusBadge) return null;
          return (
            <div className="mt-0.5">
              <span
                className={`inline-flex items-center text-xs px-1.5 py-0.5 rounded-full font-medium ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
            </div>
          );
        })()}

        {!isEditing && project.description && (
          <div className="text-xs text-peco-text-muted truncate mt-1">
            {project.description}
          </div>
        )}

        <div className="flex items-center justify-between mt-2 min-h-[28px]">
          <span className="text-xs text-peco-text-muted">
            {formatDate(project.updatedAt)}
          </span>
          {!isEditing && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                aria-label="タイトル編集"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartEdit();
                }}
                className="w-7 h-7 inline-flex items-center justify-center rounded-peco-sm text-peco-text-muted hover:text-peco-text-primary hover:bg-peco-bg"
              >
                ✏️
              </button>
              <button
                type="button"
                aria-label="プロジェクト削除"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDelete();
                }}
                className="w-7 h-7 inline-flex items-center justify-center rounded-peco-sm text-peco-text-muted hover:text-peco-danger hover:bg-peco-bg"
              >
                🗑️
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function DeleteProjectModal({
  project,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  project: ProjectSummary;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 peco-fade-in"
      onClick={() => !isDeleting && onCancel()}
    >
      <div
        className="bg-peco-bg w-full max-w-md rounded-peco-lg shadow-peco-lg peco-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-peco-gray-300">
          <h2 className="text-lg font-semibold text-peco-text-primary">
            プロジェクトを削除しますか？
          </h2>
        </div>
        <div className="px-6 py-5 space-y-2 text-sm text-peco-text-primary">
          <p>
            「<span className="font-semibold">{project.title}</span>」を削除します。
          </p>
          <p className="text-peco-text-secondary">
            この操作は取り消せません。関連する会話・ドキュメントもすべて削除されます。
          </p>
        </div>
        <div className="px-6 py-4 border-t border-peco-gray-300 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className={`${BTN_SECONDARY} h-12 px-5`}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className={`${BTN_DANGER} h-12 px-6`}
          >
            {isDeleting ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectBadge({ project }: { project: ProjectSummary }) {
  const skipBadge = project.skipRequirements ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-warning-light text-peco-warning-dark">
      ⚡ 直接実装モード
    </span>
  ) : null;
  const parallelBadge = project.isParallel ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-peco-info-light text-peco-info">
      🔀 並列
    </span>
  ) : null;

  if (project.projectType === "new") {
    return (
      <span className="inline-flex items-center gap-1 flex-wrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-secondary-light text-peco-secondary-dark">
          新規
        </span>
        {skipBadge}
        {parallelBadge}
      </span>
    );
  }
  const sys = getSystem(project.targetSystem);
  const label = project.targetLabel ?? sys?.shortLabel ?? "—";
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="inline-flex items-center px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-info-light text-peco-info">
        {label}
      </span>
      {skipBadge}
      {parallelBadge}
    </span>
  );
}

function CreateProjectModal({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    description: string;
    projectType: "existing" | "new";
    targetSystem: string | null;
    skipRequirements: boolean;
    businessCategory: BusinessCategoryId;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectType, setProjectType] = useState<"existing" | "new">("existing");
  const [targetSystem, setTargetSystem] = useState<string>(SYSTEMS[0].id);
  const [repositoryName, setRepositoryName] = useState("");
  const [skipRequirements, setSkipRequirements] = useState(false);
  const [businessCategory, setBusinessCategory] =
    useState<BusinessCategoryId>(DEFAULT_BUSINESS_CATEGORY);
  const [submitting, setSubmitting] = useState(false);

  const isValidRepoName = /^[a-z0-9][a-z0-9-]{0,49}$/.test(repositoryName.trim());

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    (projectType === "existing"
      ? targetSystem.length > 0
      : isValidRepoName);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onCreate({
        title,
        description,
        projectType,
        targetSystem: projectType === "existing" ? targetSystem : repositoryName.trim(),
        skipRequirements,
        businessCategory,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 peco-fade-in">
      <div className="bg-peco-bg w-full max-w-lg rounded-peco-lg shadow-peco-lg peco-modal-in">
        <div className="px-6 py-4 border-b border-peco-gray-300">
          <h2 className="text-lg font-semibold text-peco-text-primary">新規プロジェクト</h2>
        </div>
        <div className="px-6 py-5 space-y-5">
          <fieldset>
            <legend className="block text-sm font-medium text-peco-text-primary mb-2">
              プロジェクト種別
            </legend>
            <div className="space-y-2">
              <label
                className={`flex items-center gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  projectType === "existing"
                    ? "bg-peco-primary-subtle border border-peco-primary"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name="projectType"
                  value="existing"
                  checked={projectType === "existing"}
                  onChange={() => setProjectType("existing")}
                  className="accent-peco-primary"
                  disabled={submitting}
                />
                <span className="text-sm text-peco-text-primary">既存アプリへの追加・改修</span>
              </label>
              <label
                className={`flex items-center gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  projectType === "new"
                    ? "bg-peco-primary-subtle border border-peco-primary"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name="projectType"
                  value="new"
                  checked={projectType === "new"}
                  onChange={() => setProjectType("new")}
                  className="accent-peco-primary"
                  disabled={submitting}
                />
                <span className="text-sm text-peco-text-primary">新規アプリ開発</span>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="block text-sm font-medium text-peco-text-primary mb-2">
              開発モード
            </legend>
            <div className="space-y-2">
              <label
                className={`flex items-center gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  !skipRequirements
                    ? "bg-peco-primary-subtle border border-peco-primary"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name="skipRequirements"
                  value="false"
                  checked={!skipRequirements}
                  onChange={() => setSkipRequirements(false)}
                  className="accent-peco-primary"
                  disabled={submitting}
                />
                <span className="text-sm text-peco-text-primary">
                  要件定義から始める（推奨）
                </span>
              </label>
              <label
                className={`flex items-center gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  skipRequirements
                    ? "bg-peco-warning-light border border-peco-warning"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name="skipRequirements"
                  value="true"
                  checked={skipRequirements}
                  onChange={() => setSkipRequirements(true)}
                  className="accent-peco-warning"
                  disabled={submitting}
                />
                <span className="text-sm text-peco-text-primary">
                  ⚡ 直接実装する（要件定義スキップ）
                </span>
              </label>
            </div>
          </fieldset>

          {projectType === "existing" && (
            <label className="block">
              <span className="block text-sm font-medium text-peco-text-primary mb-1.5">
                対象システム
              </span>
              <select
                value={targetSystem}
                onChange={(e) => setTargetSystem(e.target.value)}
                disabled={submitting}
                className="w-full h-12 px-3 rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary focus:outline-none focus:border-peco-primary disabled:opacity-50"
              >
                {SYSTEMS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {projectType === "new" && (
            <label className="block">
              <span className="block text-sm font-medium text-peco-text-primary mb-1.5">
                新しいリポジトリ名を入力してください
              </span>
              <input
                type="text"
                value={repositoryName}
                onChange={(e) => setRepositoryName(e.target.value.toLowerCase())}
                disabled={submitting}
                maxLength={50}
                placeholder="例：spm-clinic-pos"
                className="w-full h-12 px-3 rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary placeholder:text-peco-text-muted focus:outline-none focus:border-peco-primary disabled:opacity-50"
              />
              <p className="mt-1.5 text-xs text-peco-text-muted">
                ~/{repositoryName.trim() || "[リポジトリ名]"} に新規作成されます
              </p>
              {repositoryName.trim().length > 0 && !isValidRepoName && (
                <p className="mt-1 text-xs text-red-500">
                  小文字英数字とハイフンのみ使用できます（例：spm-clinic-pos）
                </p>
              )}
            </label>
          )}

          <label className="block">
            <span className="block text-sm font-medium text-peco-text-primary mb-1.5">
              プロジェクト名
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              maxLength={200}
              placeholder="例：在庫アラート機能の追加"
              className="w-full h-12 px-3 rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary placeholder:text-peco-text-muted focus:outline-none focus:border-peco-primary disabled:opacity-50"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-peco-text-primary mb-1.5">
              概要（任意）
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              rows={3}
              maxLength={5000}
              placeholder="どんな改修・新機能か、簡単に"
              className="w-full resize-none rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary placeholder:text-peco-text-muted px-3 py-2 focus:outline-none focus:border-peco-primary disabled:opacity-50"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-peco-text-primary mb-1.5">
              事業カテゴリ
            </span>
            <select
              value={businessCategory}
              onChange={(e) => setBusinessCategory(e.target.value as BusinessCategoryId)}
              disabled={submitting}
              className="w-full h-12 px-3 rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary focus:outline-none focus:border-peco-primary disabled:opacity-50"
            >
              {BUSINESS_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.emoji} {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-peco-gray-300 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={`${BTN_SECONDARY} h-12 px-5`}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={`${BTN_PRIMARY} h-12 px-6`}
          >
            {submitting ? "作成中…" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PhaseBadge({ phase, label }: { phase: string; label: string }) {
  const styles: Record<string, string> = {
    initial_interview: "bg-peco-info-light text-peco-info border-peco-info",
    debate: "bg-peco-primary-light text-peco-primary-dark border-peco-primary",
    requirements_done: "bg-peco-success-light text-peco-success border-peco-success",
  };
  const icons: Record<string, string> = {
    initial_interview: "📋",
    debate: "💬",
    requirements_done: "📝",
  };
  const cls = styles[phase] ?? "bg-peco-gray-100 text-peco-text-secondary border-peco-gray-300";
  const icon = icons[phase] ?? "⏳";

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${cls}`}>
      <span>{icon}</span>
      <span>{label}</span>
      <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent peco-spin" aria-hidden />
    </span>
  );
}

const PHASE_META: Record<string, { label: string; icon: string; cls: string }> = {
  initial_interview: {
    label: "全体像の把握中",
    icon: "📋",
    cls: "bg-peco-info-light text-peco-info border-peco-info",
  },
  debate: {
    label: "チームで議論中",
    icon: "💬",
    cls: "bg-peco-primary-light text-peco-primary-dark border-peco-primary",
  },
  requirements_done: {
    label: "要件定義完了・承認待ち",
    icon: "📝",
    cls: "bg-peco-success-light text-peco-success border-peco-success",
  },
  approved: {
    label: "実装フェーズ",
    icon: "✅",
    cls: "bg-peco-success-light text-peco-success border-peco-success",
  },
};

function StaticPhaseBadge({ status }: { status: string }) {
  const meta = PHASE_META[status];
  if (!meta) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${meta.cls}`}
    >
      <span>{meta.icon}</span>
      <span>{meta.label}</span>
    </span>
  );
}

function agentTypeToKey(agentType: string): keyof AgentStatuses | null {
  switch (agentType) {
    case "orchestrator":
      return "orchestrator";
    case "requirements":
      return "agent1";
    case "pm":
      return "agent2";
    case "qa":
      return "agent3";
    default:
      return null;
  }
}

function ExecutorPanel({
  document,
  projectId,
  sessionId,
  projectType,
  targetSystem,
  targetLabel,
  isExecuting,
  isSprintReady,
  isParallel,
  sessionStatus,
  executionLog,
  executionStatus,
  executionExitCode,
  parallelSuggestion,
  parallelParts,
  parallelStatus,
  onExecute,
  onForceNormal,
  onRunParallel,
  onProjectUpdate,
  onDocumentUpdated,
  onResetRequirements,
  onResetFull,
  onClearLogs,
  canWrite = true,
}: {
  document: DocumentEntry;
  projectId: string;
  sessionId: string | null;
  projectType: "existing" | "new";
  targetSystem: string | null;
  targetLabel: string | null;
  isExecuting: boolean;
  isSprintReady: boolean;
  isParallel: boolean;
  sessionStatus: string;
  executionLog: string[];
  executionStatus: "idle" | "running" | "success" | "error";
  executionExitCode: number | null;
  parallelSuggestion:
    | null
    | { lineCount: number; sprintCount: number; documentId: string; targetRepo: string };
  parallelParts: PartInfo[];
  parallelStatus: string | null;
  onExecute: (targetRepo: string) => void;
  onForceNormal: (targetRepo: string) => void;
  onRunParallel: (targetRepo: string) => void;
  onProjectUpdate?: () => void;
  onDocumentUpdated?: (content: string) => void;
  onResetRequirements?: () => void;
  onResetFull?: () => void;
  onClearLogs?: () => void | Promise<void>;
  canWrite?: boolean;
}) {
  const [localTarget, setLocalTarget] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [summary, setSummary] = useState<{
    requirementsSummary: string | null;
    requirementsFullContent: string | null;
    sprintCounts: { sprints: number; tasks: number };
    sprintTitle: string | null;
  } | null>(null);
  const [showFullSummary, setShowFullSummary] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setSummary({
          requirementsSummary: data.requirementsSummary ?? null,
          requirementsFullContent: data.requirementsFullContent ?? null,
          sprintCounts: data.sprintCounts ?? { sprints: 0, tasks: 0 },
          sprintTitle: data.sprintTitle ?? null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, document.id, document.updatedAt]);

  const handleEditStart = () => {
    setEditContent(document.content ?? "");
    setEditing(true);
  };
  const handleEditSave = async () => {
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/documents/${document.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) throw new Error(`保存失敗 (${res.status})`);
      onDocumentUpdated?.(editContent);
      setEditing(false);
    } catch {
      // 上位で握り潰す（必要に応じてエラー表示拡張）
    } finally {
      setSavingEdit(false);
    }
  };
  const handleResetRequirements = async () => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/reset`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "requirements" }),
    });
    onResetRequirements?.();
    setConfirmDiscard(false);
  };
  const handleResetFull = async () => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/reset`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    onResetFull?.();
    setConfirmDiscard(false);
  };

  const isNewRepo = projectType === "new" && targetSystem !== null;
  const canExecute = targetSystem !== null && (isAllowedRepo(targetSystem) || isNewRepo);
  const displayLabel = targetLabel ?? targetSystem ?? "—";

  // 並列実行が全パート終端（完了/スキップ/エラー）に達したら done とみなす。
  // この状態では実行ボタン・実行中ローディングを隠し、誤操作・誤表示を防ぐ。
  const parallelDone =
    parallelParts.length > 0 &&
    parallelParts.every(
      (p) =>
        p.status === "success" ||
        p.status === "skipped" ||
        p.status === "error",
    );

  const handleConfirmTarget = async () => {
    const target = localTarget === "__new__" ? newRepoName.trim() : localTarget;
    if (!target) return;
    const label =
      localTarget === "__new__"
        ? target
        : (SYSTEMS.find((s) => s.id === localTarget)?.label ?? target);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetSystem: target, targetLabel: label }),
    });
    onProjectUpdate?.();
  };

  return (
    <div className="flex justify-start gap-3 peco-fade-in">
      <div
        className="shrink-0 w-9 h-9 rounded-full bg-peco-success flex items-center justify-center text-base shadow-peco-sm"
        aria-hidden
      >
        ⚡
      </div>
      <div className="max-w-[80%] w-full rounded-peco-lg border border-peco-success bg-peco-success-light px-5 py-4 shadow-peco-sm">
        <div className="text-sm font-medium text-peco-text-primary mb-3 flex items-center justify-between gap-2">
          <div>
            📋 設計・開発計画書が完成しました
            <span className="ml-2 text-xs text-peco-text-muted">{document.title}</span>
          </div>
          {!editing && (
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={handleEditStart}
                className={`${BTN_SECONDARY} h-8 px-3 text-xs`}
              >
                ✏️ 修正
              </button>
              <button
                type="button"
                onClick={() => setConfirmDiscard(true)}
                className={`${BTN_DANGER} h-8 px-3 text-xs`}
              >
                🗑️ 破棄
              </button>
            </div>
          )}
        </div>

        {isParallel && (
          <div className="mb-3 rounded-peco-md border border-peco-info bg-peco-info-light px-3 py-2 text-sm text-peco-info font-medium">
            🔀 並列ウォーターフォール実行モード
          </div>
        )}

        {summary && (summary.requirementsSummary || summary.sprintCounts.sprints > 0) && (
          <div className="mb-3 rounded-peco-md border border-peco-gray-300 bg-peco-bg px-3 py-2 text-sm text-peco-text-secondary space-y-1">
            {summary.requirementsSummary && (
              <div>
                <div className="text-xs font-semibold text-peco-text-primary">📝 要件サマリー</div>
                <div className="text-xs leading-relaxed">「{summary.requirementsSummary}」</div>
                {summary.requirementsFullContent &&
                  summary.requirementsFullContent.length > summary.requirementsSummary.length && (
                    <button
                      type="button"
                      onClick={() => setShowFullSummary(true)}
                      className="text-xs text-peco-primary hover:text-peco-primary-dark hover:underline cursor-pointer mt-1 transition-colors duration-150"
                    >
                      もっと見る ▼
                    </button>
                  )}
              </div>
            )}
            {(summary.sprintCounts.sprints > 0 || summary.sprintCounts.tasks > 0) && (
              <div className="text-xs">
                🗂️ 設計書：{summary.sprintCounts.sprints}スプリント / {summary.sprintCounts.tasks}タスク
              </div>
            )}
          </div>
        )}

        {showFullSummary && summary?.requirementsFullContent && (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
            onClick={() => setShowFullSummary(false)}
          >
            <div
              className="bg-peco-bg border border-peco-gray-300 rounded-peco-lg max-w-2xl w-full mx-4 p-6 max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-peco-text-primary font-medium">📝 要件定義書</h3>
                <button
                  type="button"
                  onClick={() => setShowFullSummary(false)}
                  className="text-peco-text-muted hover:text-peco-text-primary transition-colors duration-150 cursor-pointer"
                >
                  ✕
                </button>
              </div>
              <p className="text-sm text-peco-text-secondary whitespace-pre-wrap">
                {summary.requirementsFullContent}
              </p>
            </div>
          </div>
        )}

        {editing && (
          <div className="mb-3 space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={14}
              className="w-full font-mono text-xs rounded-peco-md border border-peco-gray-300 bg-peco-bg text-peco-text-primary px-3 py-2 focus:outline-none focus:border-peco-primary"
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={savingEdit}
                className={`${BTN_SECONDARY} h-9 px-3 text-sm`}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleEditSave()}
                disabled={savingEdit || editContent.trim().length === 0}
                className={`${BTN_PRIMARY} h-9 px-4 text-sm`}
              >
                {savingEdit ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}

        {confirmDiscard && (
          <div className="mb-3 rounded-peco-md border border-peco-danger bg-peco-danger-light px-4 py-3 text-sm">
            <div className="font-medium text-peco-text-primary mb-2">設計書を破棄しますか？</div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleResetRequirements()}
                className={`${BTN_SECONDARY} h-9 px-3 text-sm`}
              >
                🔄 要件定義に戻る
              </button>
              <button
                type="button"
                onClick={() => void handleResetFull()}
                className={`${BTN_DANGER} h-9 px-3 text-sm`}
              >
                🗑️ 全て削除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className={`${BTN_SECONDARY} h-9 px-3 text-sm`}
              >
                キャンセル
              </button>
            </div>
          </div>
        )}

        {!canExecute && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-peco-text-secondary">実装対象を指定してください。</p>
            <select
              value={localTarget}
              onChange={(e) => setLocalTarget(e.target.value)}
              className="border border-peco-gray-300 rounded-peco-sm px-3 py-2 text-sm bg-peco-bg text-peco-text-primary focus:outline-none focus:border-peco-primary"
            >
              <option value="">選択してください</option>
              {SYSTEMS.filter((s) => s.repoId).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="__new__">新規リポジトリを作成</option>
            </select>
            {localTarget === "__new__" && (
              <input
                type="text"
                placeholder="リポジトリ名（例：spm-clinic-pos）"
                value={newRepoName}
                onChange={(e) => setNewRepoName(e.target.value.toLowerCase())}
                className="border border-peco-gray-300 rounded-peco-sm px-3 py-2 text-sm bg-peco-bg text-peco-text-primary focus:outline-none focus:border-peco-primary"
              />
            )}
            <button
              type="button"
              onClick={() => void handleConfirmTarget()}
              disabled={!localTarget || (localTarget === "__new__" && !newRepoName.trim())}
              className={`${BTN_PRIMARY} h-10 px-4 text-sm`}
            >
              確定して実行ボタンを表示
            </button>
          </div>
        )}

        {canExecute && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 text-sm text-peco-text-primary">
              {isNewRepo ? (
                <>
                  <span className="text-peco-text-secondary mr-2">新規リポジトリ:</span>
                  <span className="font-medium">~/{targetSystem}</span>
                </>
              ) : (
                <>
                  <span className="text-peco-text-secondary mr-2">対象:</span>
                  <span className="font-medium">{displayLabel}</span>
                  <span className="text-peco-text-muted ml-2 text-xs">({targetSystem})</span>
                </>
              )}
            </div>
            {!parallelDone &&
              !['scaffolding', 'scaffolding_active', 'running', 'done'].includes(parallelStatus ?? '') &&
              !parallelParts.some((p) => p.status === 'running') && (
              <button
                type="button"
                onClick={() => onExecute(targetSystem!)}
                disabled={!isSprintReady || !canWrite}
                className={`${BTN_SUCCESS} h-12 px-6 whitespace-nowrap ${
                  !isSprintReady ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                title={!isSprintReady ? '設計書がまだ完成していません' : undefined}
              >
                🚀 {!isSprintReady
                      ? '⏳ 設計書生成中…'
                      : isNewRepo
                      ? '新規作成して実装開始'
                      : 'Claude Codeで実行'}
              </button>
            )}
            {parallelStatus === 'scaffold_error' && (
              <div className="text-sm text-red-600">
                ⚠️ 準備（scaffold）に失敗しました。リトライ: <code>npm run retry-scaffold &lt;projectId&gt;</code>
              </div>
            )}
            {!parallelDone && parallelParts.some((p) => p.status === 'running') && (
              <div className="text-sm text-peco-text-muted flex items-center gap-2">
                <div className="peco-spin text-peco-warning">⚡</div>
                Claude Codeが実行中です
              </div>
            )}
            {parallelDone && (
              <div className="text-sm font-medium text-peco-success flex items-center gap-2">
                ✅ 全パート完了
              </div>
            )}
            {!isSprintReady && (
              <div className="text-xs text-peco-text-muted mt-2">
                要件定義書と設計書が完成するまでお待ちください
              </div>
            )}
          </div>
        )}

        {parallelSuggestion && (
          <div className="mt-3 rounded-peco-md border border-peco-info bg-peco-info-light px-4 py-3 text-sm">
            <div className="font-medium text-peco-text-primary">📊 大規模開発が検出されました</div>
            <div className="text-xs text-peco-text-secondary mt-1">
              設計書: 約{parallelSuggestion.lineCount}行 / {parallelSuggestion.sprintCount}スプリント
            </div>
            <div className="text-xs text-peco-text-secondary mt-2">
              並列ウォーターフォールで実行すると独立したパートを同時開発できます。
            </div>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => onRunParallel(parallelSuggestion.targetRepo)}
                disabled={!canWrite}
                className={`${BTN_PRIMARY} h-9 px-3 text-sm`}
              >
                🔀 並列実行する
              </button>
              <button
                type="button"
                onClick={() => onForceNormal(parallelSuggestion.targetRepo)}
                disabled={!canWrite}
                className={`${BTN_SECONDARY} h-9 px-3 text-sm`}
              >
                ▶ 通常実行する
              </button>
            </div>
          </div>
        )}

        {parallelParts.length > 0 && (() => {
          const entries = [...parallelParts].sort(
            (a, b) => a.partNumber - b.partNumber,
          );
          const doneCount = entries.filter(
            (p) => p.status === "success" || p.status === "skipped",
          ).length;
          const progressPct = Math.round(
            (doneCount / Math.max(entries.length, 1)) * 100,
          );
          return (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-medium text-peco-text-muted">
                ⚡ 並列実行の進捗
              </div>
              {entries.map((part) => (
                <div
                  key={part.partNumber}
                  className="flex items-center gap-2 text-xs px-3 py-2 bg-peco-bg border border-peco-gray-200 rounded-peco-md"
                >
                  <span className="shrink-0">
                    {part.status === "success"
                      ? "✅"
                      : part.status === "running"
                        ? "⚡"
                        : part.status === "error"
                          ? "❌"
                          : part.status === "skipped"
                            ? "⏭️"
                            : "⏳"}
                  </span>
                  <span className="flex-1 truncate text-peco-text-secondary">
                    Part{part.partNumber}: {part.title ?? "（未取得）"}
                  </span>
                  <span
                    className={`shrink-0 font-medium ${
                      part.status === "success"
                        ? "text-peco-success"
                        : part.status === "running"
                          ? "text-peco-warning animate-pulse"
                          : part.status === "error"
                            ? "text-peco-danger"
                            : part.status === "skipped"
                              ? "text-peco-text-muted"
                              : "text-peco-text-muted"
                    }`}
                  >
                    {part.status === "success"
                      ? "完了"
                      : part.status === "running"
                        ? "実行中..."
                        : part.status === "error"
                          ? "エラー"
                          : part.status === "skipped"
                            ? "スキップ"
                            : "待機中"}
                  </span>
                </div>
              ))}
              <div className="mt-1">
                <div className="w-full bg-peco-gray-200 rounded-full h-1.5">
                  <div
                    className="bg-peco-success h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="text-xs text-peco-text-muted mt-0.5 text-right">
                  {doneCount}/{entries.length} 完了
                </div>
              </div>
            </div>
          );
        })()}

        {executionLog.length > 0 && (
          <div className="mt-4">
            {onClearLogs && (
              <div className="flex justify-end mb-1">
                <button
                  type="button"
                  onClick={() => void onClearLogs()}
                  className="text-xs text-peco-text-muted hover:text-peco-danger cursor-pointer transition-colors duration-150"
                >
                  🗑️ ログをクリア
                </button>
              </div>
            )}
            <LogPanel
              log={executionLog}
              status={
                parallelDone && executionStatus === "running"
                  ? "idle"
                  : executionStatus
              }
              exitCode={executionExitCode}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LogPanel({
  log,
  status,
  exitCode,
}: {
  log: string[];
  status: "idle" | "running" | "success" | "error";
  exitCode: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log.length]);

  const statusText =
    status === "running"
      ? "Claude Code 実行中..."
      : status === "success"
        ? "実行完了"
        : status === "error"
          ? `エラーが発生しました${exitCode != null ? ` (exit ${exitCode})` : ""}`
          : "";

  return (
    <div className="mt-4 bg-peco-gray-900 rounded-peco-md p-4 shadow-peco-sm">
      <div className="flex items-center gap-2 mb-2">
        {status === "running" && (
          <span
            className="inline-block w-3 h-3 rounded-full border-2 border-peco-primary border-t-transparent peco-spin"
            aria-hidden
          />
        )}
        {status === "success" && <span aria-hidden>✅</span>}
        {status === "error" && <span aria-hidden>❌</span>}
        <span className="text-peco-gray-300 text-sm font-medium">{statusText}</span>
      </div>
      <div className="text-peco-gray-300 text-xs mb-2">
        🖥️ VS Codeを起動しました。実装の様子を確認できます。
      </div>
      <div
        ref={scrollRef}
        className="font-mono text-xs text-peco-gray-100 space-y-1 max-h-60 overflow-y-auto whitespace-pre-wrap"
      >
        {log.map((line, i) => (
          <div key={i} className={slackLineClass(line)}>{line || " "}</div>
        ))}
      </div>
    </div>
  );
}

function slackLineClass(line: string): string {
  if (line.startsWith("⏳")) return "text-peco-primary font-semibold";
  if (line.startsWith("✅ Slack")) return "text-green-400 font-semibold";
  if (line.startsWith("❌") && line.includes("中止")) return "text-red-400 font-semibold";
  return "";
}

const AGENT_STYLES: Record<
  ChatMessage["role"],
  { label: string; icon: string; bgClass: string; align: "left" | "right" }
> = {
  user: {
    label: "あなた",
    icon: "👤",
    bgClass: "bg-peco-primary text-peco-gray-900",
    align: "right",
  },
  orchestrator: {
    label: "Orchestrator",
    icon: "🤖",
    bgClass: "bg-amber-50 border border-amber-200 text-peco-text-primary",
    align: "left",
  },
  agent1: {
    label: "Agent1（要件定義）",
    icon: "🔍",
    bgClass: "bg-peco-info-light border border-peco-info text-peco-text-primary",
    align: "left",
  },
  agent2: {
    label: "Agent2（設計・PM）",
    icon: "📋",
    bgClass: "bg-peco-success-light border border-peco-success text-peco-text-primary",
    align: "left",
  },
  agent3: {
    label: "Agent3（QA）",
    icon: "✅",
    bgClass: "bg-peco-warning-light border border-peco-warning text-peco-text-primary",
    align: "left",
  },
};

interface InlineQuestion {
  number: number;
  text: string;
  choices: { label: string; text: string }[];
}

function toInlineQuestions(items: QuestionItem[]): InlineQuestion[] {
  return items.map((q, i) => {
    const m = q.label.match(/(\d+)/);
    const number = m ? parseInt(m[1], 10) : i + 1;
    return {
      number,
      text: q.question,
      choices: q.choices.map((c, ci) => ({
        label: String.fromCharCode(65 + ci),
        text: c,
      })),
    };
  });
}

function InlineQuestionForm({
  questions,
  onSubmit,
}: {
  questions: InlineQuestion[];
  onSubmit: (answer: string) => void;
}) {
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const canSubmit = questions.every(
    (q) => selected[q.number] || freeText[q.number]?.trim(),
  );

  function formatAnswers() {
    return questions
      .map((q) => {
        const s = selected[q.number];
        const f = freeText[q.number]?.trim();
        const choiceText = s ? q.choices.find((c) => c.label === s)?.text ?? "" : "";
        return `Q${q.number}: ${
          s ? `${s}. ${choiceText}${f ? `（補足: ${f}）` : ""}` : f ?? ""
        }`;
      })
      .join("\n");
  }

  if (submitted) {
    return <p className="text-xs text-peco-text-muted mt-1">✅ 回答済み</p>;
  }

  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <div key={q.number} className="space-y-1.5">
          <div className="text-xs font-semibold text-current/70">Q{q.number}</div>
          {q.text && (
            <div className="text-sm font-medium leading-snug">{q.text}</div>
          )}
          {q.choices.map((c) => (
            <label
              key={c.label}
              className="flex items-start gap-2 cursor-pointer hover:opacity-80"
            >
              <input
                type="radio"
                name={`q${q.number}`}
                value={c.label}
                checked={selected[q.number] === c.label}
                onChange={() =>
                  setSelected((p) => ({ ...p, [q.number]: c.label }))
                }
                className="mt-0.5 accent-current"
              />
              <span className="text-sm">
                <span className="font-medium">{c.label}.</span> {c.text}
              </span>
            </label>
          ))}
          <textarea
            placeholder={q.choices.length > 0 ? "補足（任意）" : "回答を入力"}
            value={freeText[q.number] ?? ""}
            onChange={(e) =>
              setFreeText((p) => ({ ...p, [q.number]: e.target.value }))
            }
            rows={1}
            className="w-full text-sm border border-current/20 rounded px-2 py-1 resize-none bg-white/40 focus:outline-none focus:bg-white/60 placeholder:text-current/40"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          setSubmitted(true);
          onSubmit(formatAnswers());
        }}
        disabled={!canSubmit}
        className={`w-full py-1.5 rounded text-sm font-medium transition-all ${
          canSubmit
            ? "bg-white/60 hover:bg-white/80 text-current cursor-pointer"
            : "bg-white/20 text-current/40 cursor-not-allowed"
        }`}
      >
        回答して続ける →
      </button>
    </div>
  );
}

function ChatBubble({
  role,
  content,
  timestamp,
  isStreaming = false,
  showInteractiveForm = false,
  onAnswerSubmit,
}: {
  role: ChatMessage["role"];
  content: string;
  timestamp?: string;
  isStreaming?: boolean;
  showInteractiveForm?: boolean;
  onAnswerSubmit?: (answer: string) => void;
}) {
  const style = AGENT_STYLES[role] ?? AGENT_STYLES.orchestrator;
  const isUser = role === "user";

  const inlineQuestions = useMemo<InlineQuestion[]>(() => {
    if (role !== "orchestrator" && role !== "agent1") return [];
    return toInlineQuestions(extractQuestions(content));
  }, [role, content]);

  useMemo(() => {
    if (role === "orchestrator" || role === "agent1") {
      console.log(
        "[QUESTIONS] detected:",
        inlineQuestions.length,
        "in:",
        content.slice(0, 100),
      );
    }
  }, [role, content, inlineQuestions.length]);

  const hasQuestions = inlineQuestions.length > 0;

  return (
    <div className={`flex gap-2 mb-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div className="shrink-0 w-8 h-8 rounded-full bg-peco-gray-100 flex items-center justify-center text-base mt-1">
        {style.icon}
      </div>
      <div className={`max-w-[85%] flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}>
        {!isUser && (
          <span className="text-xs text-peco-text-muted font-medium px-1">
            {style.label}
          </span>
        )}
        <div className={`rounded-peco-lg px-4 py-3 ${style.bgClass}`}>
          {hasQuestions && showInteractiveForm && onAnswerSubmit ? (
            <>
              {(() => {
                const introText = content.split(/(?:Q|質問)\s*\d+/)[0].trim();
                return introText ? (
                  <p className="text-sm mb-3 leading-relaxed whitespace-pre-wrap break-words">
                    {introText}
                  </p>
                ) : null;
              })()}
              <InlineQuestionForm
                questions={inlineQuestions}
                onSubmit={onAnswerSubmit}
              />
            </>
          ) : (
            <>
              <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                {content || (isStreaming ? "" : "…")}
                {isStreaming && (
                  <span
                    className="inline-block w-1.5 h-4 bg-current ml-1 opacity-75 animate-pulse align-middle"
                    aria-hidden
                  />
                )}
              </div>
              {hasQuestions && !showInteractiveForm && (
                <div className="mt-2 text-xs text-peco-text-muted">✅ 回答済み</div>
              )}
            </>
          )}
        </div>
        {timestamp && (
          <span className="text-xs text-peco-text-muted px-1">{timestamp}</span>
        )}
      </div>
    </div>
  );
}

function RoundDivider({ round }: { round: number }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-peco-gray-300" />
      <span className="text-xs text-peco-text-muted px-3 py-1 bg-peco-bg border border-peco-gray-300 rounded-full">
        ラウンド {round}
      </span>
      <div className="flex-1 h-px bg-peco-gray-300" />
    </div>
  );
}

const ROUND_DIVIDER_PATTERN = /\n*---\s*ラウンド\s*(\d+)\s*---\n*/g;

interface RenderedItem {
  key: string;
  type: "bubble" | "divider";
  role?: ChatMessage["role"];
  content?: string;
  pending?: boolean;
  round?: number;
  timestamp?: string;
}

function expandMessagesForRender(messages: ChatMessage[]): RenderedItem[] {
  const items: RenderedItem[] = [];
  for (const m of messages) {
    if (m.role === "orchestrator" && /---\s*ラウンド\s*\d+\s*---/.test(m.content)) {
      const parts = m.content.split(ROUND_DIVIDER_PATTERN);
      // parts pattern: [text, num, text, num, ...]
      let chunkIdx = 0;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          const txt = (parts[i] ?? "").trim();
          if (txt.length > 0) {
            items.push({
              key: `${m.id}-c${chunkIdx++}`,
              type: "bubble",
              role: m.role,
              content: txt,
              pending: m.pending,
            });
          }
        } else {
          const round = parseInt(parts[i] ?? "1", 10);
          items.push({
            key: `${m.id}-r${round}`,
            type: "divider",
            round: Number.isFinite(round) ? round : 1,
          });
        }
      }
      continue;
    }
    items.push({
      key: m.id,
      type: "bubble",
      role: m.role,
      content: m.content,
      pending: m.pending,
    });
  }
  return items;
}

interface BubbleMeta {
  label: string;
  icon: string;
  iconBg: string;
  bubbleBg: string;
}

function bubbleMeta(role: ChatMessage["role"]): BubbleMeta {
  switch (role) {
    case "orchestrator":
      return {
        label: "Orchestrator",
        icon: "🤖",
        iconBg: "bg-peco-primary",
        bubbleBg: "bg-peco-gray-100",
      };
    case "agent1":
      return {
        label: "Agent1 要件定義",
        icon: "🔍",
        iconBg: "bg-peco-info",
        bubbleBg: "bg-peco-info-light",
      };
    case "agent2":
      return {
        label: "Agent2 設計・PM",
        icon: "📋",
        iconBg: "bg-peco-success",
        bubbleBg: "bg-peco-success-light",
      };
    case "agent3":
      return {
        label: "Agent3 QA",
        icon: "✅",
        iconBg: "bg-peco-warning",
        bubbleBg: "bg-peco-warning-light",
      };
    default:
      return {
        label: "User",
        icon: "",
        iconBg: "",
        bubbleBg: "bg-peco-primary",
      };
  }
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const meta = bubbleMeta(message.role);

  if (isUser) {
    return (
      <div className="flex justify-end peco-fade-in">
        <div className="bg-peco-primary text-peco-gray-900 rounded-peco-lg ml-auto max-w-[70%] px-4 py-3 text-base whitespace-pre-wrap leading-relaxed shadow-peco-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-3 peco-fade-in">
      <div
        className={`shrink-0 w-9 h-9 rounded-full ${meta.iconBg} flex items-center justify-center text-base shadow-peco-sm`}
        aria-hidden
      >
        {meta.icon}
      </div>
      <div
        className={`${meta.bubbleBg} rounded-peco-lg max-w-[80%] px-4 py-3 text-base text-peco-text-primary whitespace-pre-wrap leading-relaxed shadow-peco-sm`}
      >
        <div className="text-xs font-semibold text-peco-text-secondary mb-1 flex items-center gap-2">
          {meta.label}
          {message.pending && (
            <span className="inline-block w-3 h-3 rounded-full border-2 border-peco-text-muted border-t-transparent peco-spin" />
          )}
        </div>
        <div>{message.content || (message.pending ? "…" : "")}</div>
      </div>
    </div>
  );
}

interface AgentVisual {
  icon: string;
  iconBg: string;
}

function agentVisual(role: keyof AgentStatuses): AgentVisual {
  switch (role) {
    case "orchestrator":
      return { icon: "🤖", iconBg: "bg-peco-primary" };
    case "agent1":
      return { icon: "🔍", iconBg: "bg-peco-info" };
    case "agent2":
      return { icon: "📋", iconBg: "bg-peco-success" };
    case "agent3":
      return { icon: "✅", iconBg: "bg-peco-warning" };
  }
}

function AgentStatusCard({
  label,
  role,
  status,
  placeholder,
}: {
  label: string;
  role: keyof AgentStatuses;
  status: AgentStatus;
  placeholder?: boolean;
}) {
  const visual = agentVisual(role);
  const active = !placeholder && status !== "idle";

  const cardClass = placeholder
    ? "bg-peco-bg border border-peco-gray-300"
    : active
      ? "bg-peco-primary-light border border-peco-primary"
      : "bg-peco-bg border border-peco-gray-300";

  const statusText = placeholder
    ? "未実装"
    : status === "idle"
      ? "待機中"
      : status === "thinking"
        ? "実行中"
        : "応答中";

  return (
    <div className={`${cardClass} rounded-peco-md p-3 flex items-center gap-3`}>
      <div
        className={`shrink-0 w-9 h-9 rounded-full ${visual.iconBg} flex items-center justify-center text-base shadow-peco-sm`}
        aria-hidden
      >
        {visual.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-peco-text-primary truncate">{label}</div>
        <div className="text-xs text-peco-text-muted">{statusText}</div>
      </div>
      {active && (
        <span
          className="shrink-0 inline-block w-4 h-4 rounded-full border-2 border-peco-primary border-t-transparent peco-spin"
          aria-hidden
        />
      )}
    </div>
  );
}

interface QuestionItem {
  label: string;       // "Q1", "Q2" など（ドットなし）
  question: string;    // 質問文（選択肢を除いた部分）
  choices: string[];   // 選択肢テキスト（なければ空配列）
}

interface QuestionAnswer {
  selected: string | null;  // 選択肢の letter ("A"/"B"...) または "その他"。自由記述のみは null
  freeText: string;
}

const OTHER_SENTINEL = "その他";

const CIRCLE_MAP: Record<string, number> = {
  "①": 1, "②": 2, "③": 3, "④": 4, "⑤": 5,
  "⑥": 6, "⑦": 7, "⑧": 8, "⑨": 9, "⑩": 10,
};

const Q_HEADER = /^(?:#{1,4}\s*)?(?:\*{1,2})?(?:Q|質問)\s*(\d+)\s*[.．:：｜|　\s]?\s*(.+?)(?:\*{1,2})?$/;
const CIRCLE_HEADER = /^([①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)/;
const NUM_HEADER = /^(\d+)\s*[.．]\s*(.+)/;

// 選択肢パターン:
//  - **A** text / - A. text / - A) text
//  - A) text / A. text / A: text / A： text
//  - A text （スペース区切り）
const BOLD_CHOICE = /^(?:[-・*]\s+)?\*\*([A-Ea-e])\*\*\s*[.．:：)）]?\s*(.+)$/;
const PLAIN_CHOICE = /^(?:[-・*]\s+)?([A-Ea-e])[.．:：)）]\s*(.+)$/;
const SPACE_CHOICE = /^([A-Ea-e])\s+(.+)$/;

function matchChoice(line: string): string | null {
  const bold = line.match(BOLD_CHOICE);
  if (bold) return bold[2].trim();
  const plain = line.match(PLAIN_CHOICE);
  if (plain) return plain[2].trim();
  const sp = line.match(SPACE_CHOICE);
  if (sp && sp[2].trim().length > 1) return sp[2].trim();
  return null;
}

function detectHeader(
  line: string,
  itemsLength: number,
): { label: string; text: string } | null {
  const q = line.match(Q_HEADER);
  if (q) return { label: `Q${q[1]}`, text: q[2].trim() };

  const c = line.match(CIRCLE_HEADER);
  if (c) {
    const n = CIRCLE_MAP[c[1]] ?? itemsLength + 1;
    return { label: `Q${n}`, text: c[2].trim() };
  }

  const n = line.match(NUM_HEADER);
  if (n && /[？?]/.test(n[2])) {
    return { label: `Q${n[1]}`, text: n[2].trim() };
  }

  return null;
}

export function extractQuestions(content: string): QuestionItem[] {
  const results: QuestionItem[] = [];
  if (!content) return results;

  // 「質問N」/「QN」だけの行があれば次の非・選択肢行と結合し、1 行ヘッダ形式に正規化する
  const rawLines = content.split(/\r?\n/);
  const normalized: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;

    if (/^[\s　]*(?:ご質問|お伺い|質問|確認|Q)\s*\d+[.．:：]?\s*$/.test(trimmed)) {
      // 次の非空行を探す
      let j = i + 1;
      while (j < rawLines.length && !rawLines[j].trim()) j++;
      const nextLine = j < rawLines.length ? rawLines[j].trim() : "";
      if (nextLine && !/^[\s　]*[-・*]?\s*[A-Ea-e][.．:：\s]/.test(nextLine)) {
        normalized.push(`${trimmed} ${nextLine}`);
        i = j; // 次の行は消費済み
        continue;
      }
      normalized.push(trimmed);
      continue;
    }

    // 「1.」「1）」「1)」だけの行：次行を質問テキストとして結合
    const headerOnlyNumber = trimmed.match(/^(\d+)[.）)]\s*$/);
    if (headerOnlyNumber && parseInt(headerOnlyNumber[1], 10) <= 10) {
      let j = i + 1;
      while (j < rawLines.length && !rawLines[j].trim()) j++;
      const nextLine = j < rawLines.length ? rawLines[j].trim() : "";
      if (nextLine && !/^[A-Ea-e][.．:：\s]/.test(nextLine)) {
        normalized.push(`${trimmed} ${nextLine}`);
        i = j;
        continue;
      }
      normalized.push(trimmed);
      continue;
    }

    normalized.push(trimmed);
  }

  let currentLabel = "";
  let currentQuestion = "";
  let currentChoices: string[] = [];

  const push = () => {
    if (currentLabel && currentQuestion) {
      results.push({
        label: currentLabel,
        question: currentQuestion,
        choices: currentChoices,
      });
    }
  };

  for (const line of normalized) {
    // 質問行：「質問1 テキスト」「確認1: テキスト」「ご質問1：テキスト」「Q1. テキスト」「お伺い1 テキスト」
    const qMatch = line.match(
      /^[\s　]*(?:ご質問|お伺い|質問|確認|Q)\s*([1-9][0-9]?)[:：．.\s]\s*(.+)/,
    );
    if (qMatch) {
      push();
      currentLabel = `Q${qMatch[1]}`;
      currentQuestion = qMatch[2].trim();
      currentChoices = [];
      continue;
    }

    // 質問行：「1. テキスト」「1） テキスト」「1) テキスト」形式（番号 1〜99 まで）
    const qMatchNumber = line.match(/^[\s　]*([1-9][0-9]?)\s*[.．)）]\s+(.+)/);
    if (qMatchNumber) {
      push();
      currentLabel = `Q${qMatchNumber[1]}`;
      currentQuestion = qMatchNumber[2].trim();
      currentChoices = [];
      continue;
    }

    if (!currentLabel) continue;

    // 選択肢（行頭の ・/-/* 箇条書きも許容）：
    //  - 「A. テキスト」「A：テキスト」「A) テキスト」「- A テキスト」「・A) テキスト」
    const cLetter = line.match(
      /^[\s　]*[-・*]?\s*([A-Ea-e])[.．:：)）]\s*(.+)/,
    );
    const cLetterSpace = !cLetter
      ? line.match(/^[\s　]*[-・*]?\s*([A-Ea-e])\s+(.{2,})/)
      : null;
    if (cLetter || cLetterSpace) {
      const m = (cLetter ?? cLetterSpace)!;
      currentChoices.push(m[2].trim());
      continue;
    }
    //  - レター無しの箇条書き列挙：「・AWS」「- GCP」「* オンプレ」
    const cBullet = line.match(/^[\s　]*[-・*]\s+(.+)/);
    if (cBullet) {
      currentChoices.push(cBullet[1].trim());
      continue;
    }
  }

  push();
  return results;
}

function letterFor(index: number): string {
  return String.fromCharCode(65 + index);
}

function isAnswerValid(q: QuestionItem, a: QuestionAnswer | undefined): boolean {
  if (!a) return false;
  if (q.choices.length === 0) {
    return a.freeText.trim().length > 0;
  }
  if (a.selected === null) return false;
  if (a.selected === OTHER_SENTINEL) {
    return a.freeText.trim().length > 0;
  }
  return true;
}

function composeAnswerLine(
  q: QuestionItem,
  a: QuestionAnswer,
  index: number,
): string {
  const qLine = `Q${index + 1}. ${q.question}`;
  if (q.choices.length === 0) {
    return `${qLine}\nA${index + 1}. ${a.freeText.trim()}`;
  }
  if (a.selected === OTHER_SENTINEL) {
    return `${qLine}\nA${index + 1}. ${OTHER_SENTINEL}：${a.freeText.trim()}`;
  }
  if (a.selected) {
    const idx = a.selected.charCodeAt(0) - 65;
    const text = q.choices[idx] ?? "";
    return `${qLine}\nA${index + 1}. ${a.selected}（${text}）`;
  }
  return `${qLine}\nA${index + 1}. `;
}

function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      className="w-full resize-none overflow-hidden rounded-peco-md border border-peco-gray-300 px-3 py-2 text-base text-peco-text-primary placeholder:text-peco-text-muted leading-relaxed focus:outline-none focus:border-peco-primary disabled:opacity-50 bg-peco-bg"
    />
  );
}

function questionNumber(q: QuestionItem, fallback: number): number {
  const m = q.label.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : fallback;
}

function QuestionAnswerForm({
  questions,
  onSubmit,
  disabled,
}: {
  questions: QuestionItem[];
  onSubmit: (answers: string) => void;
  disabled: boolean;
}) {
  const [selectedChoices, setSelectedChoices] = useState<Record<number, string>>({});
  const [freeTexts, setFreeTexts] = useState<Record<number, string>>({});

  const numbered = questions.map((q, i) => ({
    item: q,
    number: questionNumber(q, i + 1),
  }));

  function formatAnswers(): string {
    return numbered
      .map(({ item, number }) => {
        const choiceLetter = selectedChoices[number];
        const free = freeTexts[number]?.trim();
        let answer = `Q${number}: `;
        if (choiceLetter) {
          const idx = choiceLetter.charCodeAt(0) - 65;
          const choiceText = item.choices[idx] ?? "";
          answer += `${choiceLetter}. ${choiceText}`;
          if (free) answer += `（補足: ${free}）`;
        } else {
          answer += free ?? "";
        }
        return answer;
      })
      .join("\n");
  }

  const canSubmit = numbered.every(({ item, number }) =>
    item.choices.length > 0
      ? Boolean(selectedChoices[number]) || Boolean(freeTexts[number]?.trim())
      : Boolean(freeTexts[number]?.trim()),
  );

  return (
    <div className="space-y-3">
      {numbered.map(({ item, number }, idx) => (
        <div
          key={number}
          className={`space-y-1.5 ${idx > 0 ? "pt-3 border-t border-current/10" : ""}`}
        >
          <div className="text-xs font-semibold text-current/80">Q{number}</div>
          {item.choices.length > 0 && (
            <div className="space-y-1">
              {item.choices.map((choiceText, ci) => {
                const letter = String.fromCharCode(65 + ci);
                return (
                  <label
                    key={letter}
                    className="flex items-start gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-current/5 transition-colors duration-100"
                  >
                    <input
                      type="radio"
                      name={`q${number}`}
                      value={letter}
                      checked={selectedChoices[number] === letter}
                      onChange={() =>
                        setSelectedChoices((prev) => ({ ...prev, [number]: letter }))
                      }
                      disabled={disabled}
                      className="mt-0.5 accent-peco-primary shrink-0"
                    />
                    <span className="text-sm">
                      <span className="font-medium">{letter}.</span> {choiceText}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <textarea
            placeholder={item.choices.length > 0 ? "補足があれば（任意）" : "回答を入力してください"}
            value={freeTexts[number] ?? ""}
            onChange={(e) =>
              setFreeTexts((prev) => ({ ...prev, [number]: e.target.value }))
            }
            rows={item.choices.length > 0 ? 1 : 2}
            disabled={disabled}
            className="w-full text-sm border border-current/20 rounded-peco-sm px-2.5 py-1.5 resize-none bg-transparent focus:outline-none focus:border-peco-primary placeholder:text-peco-text-muted transition-colors duration-150"
          />
        </div>
      ))}

      <button
        type="button"
        onClick={() => onSubmit(formatAnswers())}
        disabled={disabled || !canSubmit}
        className={`w-full py-2 rounded-peco-md text-sm font-medium transition-all duration-150 cursor-pointer ${
          !disabled && canSubmit
            ? "bg-peco-primary text-peco-gray-900 hover:brightness-95 active:brightness-90"
            : "bg-peco-gray-200 text-peco-text-muted cursor-not-allowed"
        }`}
      >
        回答して続ける →
      </button>
    </div>
  );
}

function QuestionForm({
  questions,
  answers,
  onChange,
  onSubmit,
  canSubmit,
  disabled,
}: {
  questions: QuestionItem[];
  answers: QuestionAnswer[];
  onChange: (index: number, patch: Partial<QuestionAnswer>) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex justify-start gap-3 peco-fade-in">
      <div
        className="shrink-0 w-9 h-9 rounded-full bg-peco-secondary flex items-center justify-center text-base shadow-peco-sm"
        aria-hidden
      >
        📝
      </div>
      <div className="max-w-[80%] w-full rounded-peco-lg border border-peco-secondary bg-peco-secondary-light px-5 py-4 shadow-peco-sm">
        <div className="text-xs font-semibold mb-3 text-peco-secondary-dark">
          質問への回答フォーム（{questions.length}件）
        </div>
        <div className="space-y-5">
          {questions.map((q, i) => (
            <QuestionRow
              key={i}
              index={i}
              question={q}
              answer={answers[i] ?? { selected: null, freeText: "" }}
              onChange={(patch) => onChange(i, patch)}
              disabled={disabled}
            />
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !canSubmit}
            className={`${BTN_PRIMARY} h-12 px-6`}
          >
            まとめて送信
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionRow({
  index,
  question,
  answer,
  onChange,
  disabled,
}: {
  index: number;
  question: QuestionItem;
  answer: QuestionAnswer;
  onChange: (patch: Partial<QuestionAnswer>) => void;
  disabled: boolean;
}) {
  const hasChoices = question.choices.length > 0;
  const radioName = `q-${index}`;

  return (
    <div>
      <div className="block text-sm font-medium mb-2 text-peco-text-primary">
        <span className="text-peco-secondary mr-1">Q{index + 1}.</span>
        {question.question}
      </div>

      {!hasChoices && (
        <AutoResizeTextarea
          value={answer.freeText}
          onChange={(value) => onChange({ freeText: value })}
          placeholder="自由に記述してください..."
          disabled={disabled}
        />
      )}

      {hasChoices && (
        <div className="space-y-1.5">
          {question.choices.map((text, ci) => {
            const letter = letterFor(ci);
            const checked = answer.selected === letter;
            return (
              <label
                key={ci}
                className={`flex items-start gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  checked
                    ? "bg-peco-primary-subtle border border-peco-primary"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={letter}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange({ selected: letter, freeText: "" })}
                  className="mt-1 accent-peco-primary"
                />
                <span className="text-sm text-peco-text-primary leading-relaxed">
                  <span className="font-semibold mr-2">{letter}</span>
                  {text}
                </span>
              </label>
            );
          })}
          {(() => {
            const checked = answer.selected === OTHER_SENTINEL;
            return (
              <label
                className={`flex items-start gap-3 px-3 py-2 rounded-peco-sm cursor-pointer transition-colors ${
                  checked
                    ? "bg-peco-primary-subtle border border-peco-primary"
                    : "border border-transparent hover:bg-peco-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={OTHER_SENTINEL}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange({ selected: OTHER_SENTINEL })}
                  className="mt-1 accent-peco-primary"
                />
                <span className="text-sm text-peco-text-primary leading-relaxed">
                  その他（自由記述）
                </span>
              </label>
            );
          })()}
          {answer.selected === OTHER_SENTINEL && (
            <div className="mt-2 pl-3">
              <textarea
                value={answer.freeText}
                onChange={(e) => onChange({ freeText: e.target.value })}
                disabled={disabled}
                rows={2}
                placeholder="自由に記述してください..."
                className="w-full resize-none rounded-peco-sm border border-peco-gray-300 px-3 py-2 text-base text-peco-text-primary placeholder:text-peco-text-muted bg-peco-bg focus:outline-none focus:border-peco-primary disabled:opacity-50"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
