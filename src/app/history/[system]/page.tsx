import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { SYSTEMS, getSystem, NEW_GROUP_LABEL } from "@/lib/systems";
import { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const NEW_KEY = "new";

const ICONS: Record<string, string> = {
  "spm-project-2": "💼",
  "spm-diagnosis": "🩺",
  "peco-stock": "📦",
  "peco-property": "🏠",
  "spm-dev-agent": "🤖",
  other: "🔖",
  new: "✨",
};

interface PageProps {
  params: Promise<{ system: string }>;
}

export default async function HistoryPage({ params }: PageProps) {
  const { system: systemParam } = await params;

  let headerLabel: string;
  let where: Prisma.ProjectWhereInput;

  if (systemParam === NEW_KEY) {
    headerLabel = NEW_GROUP_LABEL;
    where = { projectType: "new" };
  } else {
    const sys = getSystem(systemParam);
    if (!sys) {
      notFound();
    }
    headerLabel = sys.shortLabel;
    where = { projectType: "existing", targetSystem: sys.id };
  }

  const projects = await prisma.project.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      documents: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          title: true,
          obsidianPath: true,
          executedAt: true,
          createdAt: true,
        },
      },
    },
  });

  const icon = ICONS[systemParam] ?? "📁";

  return (
    <main className="flex flex-col min-h-screen bg-peco-bg">
      <header className="h-14 shrink-0 flex items-center justify-between px-6 bg-peco-bg border-b border-peco-gray-300">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <h1 className="text-lg font-semibold tracking-tight text-peco-text-primary">
            {headerLabel} — 開発履歴
          </h1>
          <span className="text-xs text-peco-text-muted">{projects.length} プロジェクト</span>
        </div>
        <nav className="flex items-center gap-3 text-xs">
          <Link href="/" className="text-peco-text-secondary hover:text-peco-secondary">
            ← ワークスペースへ
          </Link>
        </nav>
      </header>

      <div className="px-6 py-4 border-b border-peco-gray-300 flex flex-wrap gap-2">
        <HistoryLink href={`/history/${NEW_KEY}`} active={systemParam === NEW_KEY}>
          {ICONS[NEW_KEY]} {NEW_GROUP_LABEL}
        </HistoryLink>
        {SYSTEMS.map((s) => (
          <HistoryLink
            key={s.id}
            href={`/history/${s.id}`}
            active={systemParam === s.id}
          >
            {ICONS[s.id] ?? "📁"} {s.shortLabel}
          </HistoryLink>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        {projects.length === 0 && (
          <p className="text-peco-text-muted text-sm">プロジェクトはまだありません。</p>
        )}
        <ul className="space-y-4 max-w-3xl">
          {projects.map((p) => {
            const reqDoc = p.documents.find((d) => d.type === "requirements") ?? null;
            const sprintDoc = p.documents.find((d) => d.type === "sprint") ?? null;
            return (
              <li
                key={p.id}
                className="bg-peco-bg border border-peco-gray-300 rounded-peco-md shadow-peco-sm p-5 peco-fade-in"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold ${
                          p.projectType === "new"
                            ? "bg-peco-secondary-light text-peco-secondary-dark"
                            : "bg-peco-info-light text-peco-info"
                        }`}
                      >
                        {p.projectType === "new"
                          ? "新規"
                          : p.targetLabel ?? "—"}
                      </span>
                      <StatusBadge status={p.status} />
                    </div>
                    <h2 className="text-base font-semibold text-peco-text-primary truncate">
                      {p.title}
                    </h2>
                    {p.description && (
                      <p className="text-sm text-peco-text-secondary mt-1 line-clamp-2">
                        {p.description}
                      </p>
                    )}
                  </div>
                  <div className="text-xs text-peco-text-muted shrink-0">
                    {formatDate(p.updatedAt)}
                  </div>
                </div>

                {(reqDoc || sprintDoc || p.documents.length > 0) && (
                  <ul className="mt-3 pt-3 border-t border-peco-gray-100 space-y-1.5">
                    {p.documents.map((d) => (
                      <li key={d.id} className="text-sm flex items-start gap-2">
                        <DocTypeBadge type={d.type} />
                        <span className="text-peco-text-primary">{d.title}</span>
                        {d.executedAt && (
                          <span className="text-xs text-peco-success">
                            ⚡ 実行済 {formatDate(d.executedAt)}
                          </span>
                        )}
                        {d.obsidianPath && (
                          <span className="text-xs text-peco-text-muted truncate ml-auto">
                            📚 {compressPath(d.obsidianPath)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}

function HistoryLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center px-3 py-1.5 rounded-peco-sm text-xs font-medium transition-colors ${
        active
          ? "bg-peco-primary text-peco-gray-900"
          : "bg-peco-gray-100 text-peco-text-secondary hover:bg-peco-gray-50"
      }`}
    >
      {children}
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    active: { bg: "bg-peco-success-light", text: "text-peco-success", label: "進行中" },
    completed: { bg: "bg-peco-info-light", text: "text-peco-info", label: "完了" },
    archived: { bg: "bg-peco-gray-100", text: "text-peco-text-muted", label: "アーカイブ" },
  };
  const m = map[status] ?? map.active;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-peco-sm text-[11px] font-semibold ${m.bg} ${m.text}`}>
      {m.label}
    </span>
  );
}

function DocTypeBadge({ type }: { type: string }) {
  const map: Record<string, { icon: string; label: string }> = {
    requirements: { icon: "📋", label: "要件定義" },
    sprint: { icon: "📐", label: "設計・計画" },
    test_report: { icon: "🧪", label: "テスト" },
    summary: { icon: "✅", label: "完了" },
  };
  const m = map[type] ?? { icon: "📄", label: type };
  return (
    <span className="inline-flex items-center gap-1 text-xs text-peco-text-secondary shrink-0">
      <span>{m.icon}</span>
      <span>{m.label}</span>
    </span>
  );
}

function formatDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function compressPath(p: string): string {
  // ホームディレクトリのプレフィックスは省略
  return p.replace(/^.*Obsidian Vault\//, "📚 ");
}
