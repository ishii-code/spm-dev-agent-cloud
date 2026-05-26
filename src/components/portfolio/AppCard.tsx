'use client'

import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { StatusBadge } from './StatusBadge'
import type { AppPortfolioWithOrgs, AppStatusType, OrgNameType } from '@/types/portfolio'

interface ExecutingInfo {
  targetSystem: string | null
  currentPart: { partNumber: number | null; partTitle: string | null } | null
}

interface Props {
  app: AppPortfolioWithOrgs
  isAdmin: boolean
  onStatusChange: (id: string, status: AppStatusType) => void
  onOrgChange: (id: string, orgNames: OrgNameType[]) => void
  // ステータス編集の可否。未指定時は isAdmin に従う（組織別ビューの既存挙動）。
  // カテゴリ別ビューでは false を渡し、D&D のみ有効・ステータス編集は無効にする。
  canEditStatus?: boolean
  executingInfo?: ExecutingInfo | null
  onExecutingClick?: (targetSystem: string) => void
}

export function AppCard({ app, isAdmin, onStatusChange, canEditStatus, executingInfo, onExecutingClick }: Props) {
  // 管理者モード時は AppPortfolio / Project とも D&D 可能
  const isDraggable = isAdmin
  const statusEditable = canEditStatus ?? isAdmin
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: app.id,
    disabled: !isDraggable,
  })

  const style = transform
    ? { transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.5 : 1 }
    : undefined

  const extraOrgs = app.orgMappings.length - 1

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isDraggable ? { ...listeners, ...attributes } : {})}
      className={`bg-white border border-peco-gray-300 rounded-lg p-3 shadow-sm select-none transition-all duration-150 hover:shadow-peco-md hover:bg-peco-gray-50 ${isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'} ${isDragging ? 'shadow-lg' : ''}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-sm text-peco-text-primary leading-tight line-clamp-2 break-words" title={app.name}>{app.name}</span>
        {app.source === 'project' && app.projectStatusLabel ? (
          <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-peco-gray-100 text-peco-text-secondary">
            {app.projectStatusLabel}
          </span>
        ) : (
          <StatusBadge
            status={app.status}
            isEditable={statusEditable}
            onChange={(s) => onStatusChange(app.id, s)}
          />
        )}
      </div>

      {app.description && (
        <p className="text-xs text-peco-text-secondary mb-2 line-clamp-2">{app.description}</p>
      )}

      <div className="flex flex-wrap gap-1 mt-1">
        {app.portNumber && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-peco-gray-100 text-peco-text-muted">
            Port: {app.portNumber}
          </span>
        )}
        {app.isFromCode && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-peco-primary-light text-peco-primary-dark font-medium">
            コード定義
          </span>
        )}
        {app.source === 'project' && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-peco-info-light text-peco-info font-medium">
            開発案件
          </span>
        )}
        {extraOrgs > 0 && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-peco-info-light text-peco-info">
            他{extraOrgs}組織でも使用中
          </span>
        )}
      </div>

      {app.techStack && (
        <p className="text-[10px] text-peco-text-muted mt-1.5 truncate">{app.techStack}</p>
      )}

      {executingInfo && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (executingInfo.targetSystem) onExecutingClick?.(executingInfo.targetSystem)
          }}
          className="mt-2 w-full inline-flex items-center gap-1.5 px-2 py-1 rounded-peco-md border border-peco-warning bg-peco-warning-light text-peco-warning text-[11px] font-semibold hover:opacity-90 transition-opacity"
        >
          <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent peco-spin" aria-hidden />
          <span>⚡ Claude Code実行中</span>
          {executingInfo.currentPart?.partTitle && (
            <span className="font-normal truncate">
              （Part{executingInfo.currentPart.partNumber}: {executingInfo.currentPart.partTitle}）
            </span>
          )}
        </button>
      )}
    </div>
  )
}
