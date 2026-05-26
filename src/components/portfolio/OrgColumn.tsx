'use client'

import { useDroppable } from '@dnd-kit/core'
import { AppCard } from './AppCard'
import type { AppPortfolioWithOrgs, AppStatusType, OrgNameType } from '@/types/portfolio'
import { ORG_LABELS } from '@/types/portfolio'

interface ExecutingInfo {
  targetSystem: string | null
  currentPart: { partNumber: number | null; partTitle: string | null } | null
}

interface Props {
  orgName: OrgNameType
  apps: AppPortfolioWithOrgs[]
  isAdmin: boolean
  onStatusChange: (id: string, status: AppStatusType) => void
  onOrgChange: (id: string, orgNames: OrgNameType[]) => void
  executingByName?: Map<string, ExecutingInfo>
  onExecutingClick?: (targetSystem: string) => void
}

export function OrgColumn({
  orgName,
  apps,
  isAdmin,
  onStatusChange,
  onOrgChange,
  executingByName,
  onExecutingClick,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: orgName })

  return (
    <div className="flex flex-col min-w-52 w-52 shrink-0">
      <div className="mb-2 px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-peco-text-primary">{ORG_LABELS[orgName]}</h2>
          <span className="text-xs bg-peco-gray-100 text-peco-text-muted px-1.5 py-0.5 rounded-full">
            {apps.length} apps
          </span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={`flex-1 min-h-32 rounded-lg p-2 flex flex-col gap-2 transition-colors ${
          isOver ? 'bg-peco-primary-light border-2 border-dashed border-peco-primary' : 'bg-peco-gray-50 border border-peco-gray-300'
        }`}
      >
        {apps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            isAdmin={isAdmin}
            onStatusChange={onStatusChange}
            onOrgChange={onOrgChange}
            executingInfo={executingByName?.get(app.name) ?? null}
            onExecutingClick={onExecutingClick}
          />
        ))}
        {apps.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-xs text-peco-text-muted py-4">
            {isAdmin ? 'ここにドロップ' : 'アプリなし'}
          </div>
        )}
      </div>
    </div>
  )
}
