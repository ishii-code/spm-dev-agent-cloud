import { prisma } from "@/lib/prisma";
import { ChatWorkspace } from "@/components/ChatWorkspace";
import { DEFAULT_BUSINESS_CATEGORY } from "@/lib/categories";

export const dynamic = "force-dynamic";

export default async function Page() {
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      projectType: true,
      targetSystem: true,
      targetLabel: true,
      skipRequirements: true,
      isParallel: true,
      businessCategory: true,
      updatedAt: true,
      sessions: {
        select: { status: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
    },
  });

  return (
    <main className="flex flex-col h-screen min-h-0">
      <header className="h-14 shrink-0 flex items-center justify-between px-6 bg-peco-bg border-b border-peco-gray-300">
        <div className="flex items-center gap-3">
          <span className="inline-block w-3 h-3 rounded-full bg-peco-primary" />
          <h1 className="text-lg font-semibold tracking-tight text-peco-text-primary">SPM Dev Agent</h1>
          <span className="text-xs text-peco-text-muted">
            Phase1 MVP — Orchestrator + Agent1
          </span>
        </div>
        <span className="text-xs text-peco-text-muted">:3005</span>
      </header>
      <ChatWorkspace
        initialProjects={projects.map((p) => {
          const sessionStatus = p.sessions[0]?.status ?? "initial_interview";
          return {
            id: p.id,
            title: p.title,
            description: p.description,
            status: p.status,
            projectType: p.projectType,
            targetSystem: p.targetSystem,
            targetLabel: p.targetLabel,
            skipRequirements: p.skipRequirements,
            isParallel: p.isParallel,
            businessCategory: p.businessCategory ?? DEFAULT_BUSINESS_CATEGORY,
            sessionStatus,
            isExecuting: sessionStatus === "executing",
            updatedAt: p.updatedAt.toISOString(),
          };
        })}
      />
    </main>
  );
}
