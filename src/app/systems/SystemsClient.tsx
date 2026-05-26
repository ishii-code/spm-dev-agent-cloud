"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Color =
  | "peco-primary"
  | "peco-secondary"
  | "peco-info"
  | "peco-success"
  | "peco-warning"
  | "peco-danger";

interface SystemView {
  id: string;
  label: string;
  description: string;
  port: number;
  icon: string;
  color: Color;
  projectCount: number;
}

type RunStatus = "running" | "stopped" | "starting" | "error";

const POLL_INTERVAL_MS = 5000;

export function SystemsClient({ initialSystems }: { initialSystems: SystemView[] }) {
  const [systems] = useState<SystemView[]>(initialSystems);
  const [statusById, setStatusById] = useState<Record<string, RunStatus>>(() => {
    const initial: Record<string, RunStatus> = {};
    for (const s of initialSystems) initial[s.id] = "stopped";
    return initial;
  });
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const pollingPaused = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (pollingPaused.current) return;
    try {
      const res = await fetch("/api/systems/status", { cache: "no-store" });
      if (!res.ok) return;
      const data: { id: string; running: boolean }[] = await res.json();
      setStatusById((prev) => {
        const next = { ...prev };
        for (const row of data) {
          // starting 中は上書きしない（起動完了の応答を待つ）
          if (next[row.id] === "starting") continue;
          next[row.id] = row.running ? "running" : "stopped";
        }
        return next;
      });
    } catch {
      // 無視
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const handle = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [fetchStatus]);

  const handleOpenVscode = useCallback(async (sys: SystemView) => {
    setErrorById((prev) => ({ ...prev, [sys.id]: null }));
    try {
      const res = await fetch("/api/systems/vscode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemId: sys.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setErrorById((prev) => ({
          ...prev,
          [sys.id]:
            data?.message ?? "VS Code起動失敗（`code` コマンドが PATH にあるか確認してください）",
        }));
      }
    } catch {
      setErrorById((prev) => ({
        ...prev,
        [sys.id]: "VS Code起動失敗",
      }));
    }
  }, []);

  const handleStart = useCallback(
    async (sys: SystemView) => {
      setStatusById((prev) => ({ ...prev, [sys.id]: "starting" }));
      setErrorById((prev) => ({ ...prev, [sys.id]: null }));
      pollingPaused.current = true;
      try {
        const res = await fetch("/api/systems/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ systemId: sys.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          setStatusById((prev) => ({ ...prev, [sys.id]: "running" }));
          window.open(`http://localhost:${sys.port}`, "_blank", "noopener");
        } else {
          setStatusById((prev) => ({ ...prev, [sys.id]: "error" }));
          setErrorById((prev) => ({
            ...prev,
            [sys.id]:
              data?.message ?? "起動失敗。ターミナルで確認してください。",
          }));
        }
      } catch {
        setStatusById((prev) => ({ ...prev, [sys.id]: "error" }));
        setErrorById((prev) => ({
          ...prev,
          [sys.id]: "起動失敗。ターミナルで確認してください。",
        }));
      } finally {
        pollingPaused.current = false;
        // すぐに次の status を引く
        void fetchStatus();
      }
    },
    [fetchStatus],
  );

  return (
    <main className="flex flex-col min-h-screen bg-peco-bg">
      <header className="h-14 shrink-0 flex items-center justify-between px-6 bg-peco-bg border-b border-peco-gray-300">
        <Link
          href="/"
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          title="ワークスペースに戻る"
        >
          <span className="text-2xl" aria-hidden>🖥️</span>
          <h1 className="text-lg font-semibold tracking-tight text-peco-text-primary">
            SPMシステム一覧
          </h1>
        </Link>
        <nav className="flex items-center gap-3 text-xs">
          <Link href="/" className="text-peco-text-secondary hover:text-peco-secondary">
            ← ワークスペースへ
          </Link>
        </nav>
      </header>

      <div className="px-6 py-4 border-b border-peco-gray-300">
        <p className="text-sm text-peco-text-secondary">
          各システムの起動状態を確認・管理できます。
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {systems.map((sys) => (
            <SystemCard
              key={sys.id}
              system={sys}
              status={statusById[sys.id] ?? "stopped"}
              errorMessage={errorById[sys.id] ?? null}
              onStart={() => void handleStart(sys)}
              onOpenVscode={() => void handleOpenVscode(sys)}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function SystemCard({
  system,
  status,
  errorMessage,
  onStart,
  onOpenVscode,
}: {
  system: SystemView;
  status: RunStatus;
  errorMessage: string | null;
  onStart: () => void;
  onOpenVscode: () => void;
}) {
  const openUrl = `http://localhost:${system.port}`;

  return (
    <div className="bg-peco-bg border border-peco-gray-300 rounded-peco-lg shadow-peco-sm p-5 peco-fade-in">
      <div className="flex items-start gap-3">
        <div
          className={`shrink-0 w-12 h-12 rounded-peco-md flex items-center justify-center text-2xl bg-${system.color}-light`}
          style={{ backgroundColor: `var(--${system.color}-light)` }}
          aria-hidden
        >
          {system.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-base font-semibold text-peco-text-primary truncate">
              {system.label}
            </h2>
            <StatusBadge status={status} />
          </div>
          <p className="text-sm text-peco-text-secondary line-clamp-2">
            {system.description}
          </p>
          <p className="text-xs text-peco-text-muted mt-1 font-mono">
            localhost:{system.port}
          </p>
        </div>
      </div>

      {errorMessage && (
        <div className="mt-3 text-xs text-peco-danger bg-peco-danger-light rounded-peco-sm px-3 py-2">
          {errorMessage}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {status === "running" && (
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center h-12 px-4 rounded-peco-md bg-peco-primary text-peco-gray-900 hover:bg-peco-primary-dark font-medium transition-colors"
          >
            🚀 開く
          </a>
        )}
        {(status === "stopped" || status === "error") && (
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center justify-center h-12 px-4 rounded-peco-md bg-peco-success text-white hover:opacity-90 font-medium transition-opacity"
          >
            ▶ 起動して開く
          </button>
        )}
        {status === "starting" && (
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-2 justify-center h-12 px-4 rounded-peco-md bg-peco-warning-light text-peco-warning font-medium opacity-90 cursor-wait"
          >
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-peco-warning border-t-transparent peco-spin"
              aria-hidden
            />
            起動中…
          </button>
        )}
        <button
          type="button"
          onClick={onOpenVscode}
          className="inline-flex items-center justify-center h-12 px-4 rounded-peco-md border border-peco-gray-300 text-peco-text-secondary hover:bg-peco-gray-100 font-medium transition-colors bg-peco-bg text-sm"
        >
          🖥️ VS Codeで開く
        </button>
        <Link
          href={`/history/${system.id}`}
          className="inline-flex items-center justify-center h-12 px-4 rounded-peco-md border border-peco-gray-300 text-peco-text-secondary hover:bg-peco-gray-100 font-medium transition-colors bg-peco-bg"
        >
          開発履歴 {system.projectCount}件
        </Link>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-success-light text-peco-success">
        <span aria-hidden>●</span> 起動中
      </span>
    );
  }
  if (status === "starting") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-warning-light text-peco-warning">
        <span
          className="inline-block w-2 h-2 rounded-full border-2 border-peco-warning border-t-transparent peco-spin"
          aria-hidden
        />
        起動中...
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-danger-light text-peco-danger">
        <span aria-hidden>✕</span> エラー
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold bg-peco-gray-100 text-peco-text-muted">
      <span aria-hidden>○</span> 停止中
    </span>
  );
}
