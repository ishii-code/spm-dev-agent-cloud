'use client'

import { useDroppable } from '@dnd-kit/core'
import { AppCard } from './AppCard'
import type { AppPortfolioWithOrgs } from '@/types/portfolio'
import type { BusinessCategoryMeta } from '@/lib/categories'

interface ExecutingInfo {
  targetSystem: string | null
  currentPart: { partNumber: number | null; partTitle: string | null } | null
}

interface Props {
  category: BusinessCategoryMeta
  apps: AppPortfolioWithOrgs[]
  isAdmin: boolean
  executingByName?: Map<string, ExecutingInfo>
  onExecutingClick?: (targetSystem: string) => void
}

// カテゴリ別ビューのカラム。管理者モード時はドロップ受け入れ + カード D&D が有効。
// 見た目は OrgColumn を踏襲し、見出しを絵文字+カテゴリ名にする。
export function CategoryColumn({ category, apps, isAdmin, executingByName, onExecutingClick }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: category.id })

  return (
    <div className="flex flex-col min-w-52 w-52 shrink-0">
      <div className="mb-2 px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-peco-text-primary">
            <span aria-hidden>{category.emoji}</span> {category.name}
          </h2>
          <span className="text-xs bg-peco-gray-100 text-peco-text-muted px-1.5 py-0.5 rounded-full">
            {apps.length} apps
          </span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={`flex-1 min-h-32 rounded-lg p-2 flex flex-col gap-2 transition-colors ${
          isOver && isAdmin
            ? 'bg-peco-primary-light border-2 border-dashed border-peco-primary'
            : 'bg-peco-gray-50 border border-peco-gray-300'
        }`}
      >
        {apps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            isAdmin={isAdmin}
            canEditStatus={false}
            onStatusChange={() => undefined}
            onOrgChange={() => undefined}
            executingInfo={executingByName?.get(app.name) ?? null}
            onExecutingClick={onExecutingClick}
          />
        ))}
        {apps.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-xs text-peco-text-muted py-4">
            {isAdmin ? 'ここにドロップ' : '該当なし'}
          </div>
        )}
      </div>
    </div>
  )
}
