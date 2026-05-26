'use client'

import { useState, useEffect, useOptimistic, useCallback } from 'react'
import Link from 'next/link'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { OrgColumn } from '@/components/portfolio/OrgColumn'
import { CategoryColumn } from '@/components/portfolio/CategoryColumn'
import { AppCard } from '@/components/portfolio/AppCard'
import { AddAppModal } from '@/components/portfolio/AddAppModal'
import { ChangeLogPanel } from '@/components/portfolio/ChangeLogPanel'
import { TechStackSummary } from '@/components/portfolio/TechStackSummary'
import type { AppPortfolioWithOrgs, AppStatusType, OrgNameType } from '@/types/portfolio'
import { ORG_ORDER } from '@/types/portfolio'
import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_IDS, type BusinessCategoryId } from '@/lib/categories'

type ViewMode = 'org' | 'category'

// Project 由来カードの id は "project:<cuid>"。実 id を取り出す。
function realProjectId(id: string): string {
  return id.startsWith('project:') ? id.slice('project:'.length) : id
}

interface ExecutingItem {
  sessionId: string
  projectId: string
  projectTitle: string
  targetSystem: string | null
  targetLabel: string | null
  currentPart: { partNumber: number | null; partTitle: string | null } | null
}

interface PartProgress {
  partNumber: number | null
  partTitle: string | null
  status: 'waiting' | 'executing' | 'completed' | 'error'
}

export default function SystemsPage() {
  const [apps, setApps] = useState<AppPortfolioWithOrgs[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [activeApp, setActiveApp] = useState<AppPortfolioWithOrgs | null>(null)
  const [error, setError] = useState('')
  const [executing, setExecuting] = useState<ExecutingItem[]>([])
  const [partsModalSystem, setPartsModalSystem] = useState<string | null>(null)
  const [partsModalData, setPartsModalData] = useState<{
    projectTitle: string | null
    parts: PartProgress[]
  } | null>(null)
  const [showChangeLog, setShowChangeLog] = useState(false)
  const [showTechStack, setShowTechStack] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('org')
  const [dndError, setDndError] = useState<string | null>(null)

  const [optimisticApps, updateOptimistic] = useOptimistic(
    apps,
    (current: AppPortfolioWithOrgs[], update: AppPortfolioWithOrgs[]) => update,
  )

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  useEffect(() => {
    const token = sessionStorage.getItem('adminToken')
    if (token) setIsAdmin(true)
  }, [])

  const fetchApps = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const res = await fetch('/api/portfolio')
      if (!res.ok) throw new Error('fetch failed')
      const data = await res.json() as AppPortfolioWithOrgs[]
      setApps(data)
    } catch {
      setError('データの取得に失敗しました')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void fetchApps() }, [fetchApps])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch('/api/systems/executing')
        if (!r.ok) return
        const data = await r.json() as { executing: ExecutingItem[] }
        if (alive) setExecuting(data.executing ?? [])
      } catch {
        // ignore
      }
    }
    void tick()
    const id = window.setInterval(tick, 5000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    if (!partsModalSystem) {
      setPartsModalData(null)
      return
    }
    let alive = true
    const fetchParts = async () => {
      try {
        const r = await fetch(`/api/systems/${partsModalSystem}/parts`)
        if (!r.ok) return
        const data = await r.json() as {
          projectTitle: string | null
          parts: PartProgress[]
        }
        if (alive) setPartsModalData({ projectTitle: data.projectTitle, parts: data.parts ?? [] })
      } catch {
        // ignore
      }
    }
    void fetchParts()
    const id = window.setInterval(fetchParts, 3000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [partsModalSystem])

  const executingByName = new Map<string, ExecutingItem>()
  executing.forEach((e) => {
    if (e.projectTitle) executingByName.set(e.projectTitle, e)
    if (e.targetLabel) executingByName.set(e.targetLabel, e)
  })

  function handleAdminToggle() {
    if (isAdmin) {
      sessionStorage.removeItem('adminToken')
      setIsAdmin(false)
      return
    }
    const password = window.prompt('管理者パスワードを入力してください:')
    if (!password) return
    sessionStorage.setItem('adminToken', password)
    setIsAdmin(true)
  }

  async function handleStatusChange(id: string, status: AppStatusType) {
    const prev = apps.find((a) => a.id === id)
    if (!prev || prev.status === status) return
    const next = apps.map((a) => a.id === id ? { ...a, status } : a)
    updateOptimistic(next)
    setApps(next)
    try {
      const token = sessionStorage.getItem('adminToken') ?? ''
      const res = await fetch(`/api/portfolio/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        setApps(apps)
        updateOptimistic(apps)
      }
    } catch {
      setApps(apps)
      updateOptimistic(apps)
    }
  }

  async function handleOrgChange(id: string, orgNames: OrgNameType[]) {
    const token = sessionStorage.getItem('adminToken') ?? ''
    const next = apps.map((a) =>
      a.id === id ? { ...a, orgMappings: orgNames.map((orgName) => ({ orgName })) } : a,
    )
    updateOptimistic(next)
    setApps(next)
    try {
      const res = await fetch(`/api/portfolio/${id}/mapping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ orgNames }),
      })
      if (!res.ok) {
        setApps(apps)
        updateOptimistic(apps)
      }
    } catch {
      setApps(apps)
      updateOptimistic(apps)
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const app = apps.find((a) => a.id === event.active.id)
    setActiveApp(app ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveApp(null)
    const { active, over } = event
    if (!over || !isAdmin) return
    const draggedId = String(active.id)
    const overId = String(over.id)
    const app = apps.find((a) => a.id === draggedId)
    if (!app) return

    if (viewMode === 'org') {
      const targetOrg = overId as OrgNameType
      if (!ORG_ORDER.includes(targetOrg)) return
      if (app.orgMappings.some((m) => m.orgName === targetOrg)) return
      void reassignOrg(app, targetOrg)
    } else {
      const targetCat = overId as BusinessCategoryId
      if (!BUSINESS_CATEGORY_IDS.includes(targetCat)) return
      if (app.businessCategory === targetCat) return
      void reassignCategory(app, targetCat)
    }
  }

  // 楽観的更新 + 失敗時ロールバック + エラートースト の共通ラッパー
  async function optimisticPatch(
    nextApps: AppPortfolioWithOrgs[],
    request: () => Promise<Response>,
    errorMessage: string,
  ) {
    const prevApps = apps
    updateOptimistic(nextApps)
    setApps(nextApps)
    try {
      const res = await request()
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      setApps(prevApps)
      updateOptimistic(prevApps)
      setDndError(errorMessage)
      window.setTimeout(() => setDndError(null), 4000)
    }
  }

  async function reassignOrg(app: AppPortfolioWithOrgs, targetOrg: OrgNameType) {
    const token = sessionStorage.getItem('adminToken') ?? ''
    const next = apps.map((a) =>
      a.id === app.id ? { ...a, orgMappings: [{ orgName: targetOrg }] } : a,
    )
    if (app.source === 'project') {
      await optimisticPatch(
        next,
        () =>
          fetch(`/api/projects/${realProjectId(app.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
            body: JSON.stringify({ orgName: targetOrg }),
          }),
        '組織の変更に失敗しました',
      )
    } else {
      await optimisticPatch(
        next,
        () =>
          fetch(`/api/portfolio/${app.id}/mapping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
            body: JSON.stringify({ orgNames: [targetOrg] }),
          }),
        '組織の変更に失敗しました',
      )
    }
  }

  async function reassignCategory(app: AppPortfolioWithOrgs, targetCat: BusinessCategoryId) {
    const token = sessionStorage.getItem('adminToken') ?? ''
    const next = apps.map((a) =>
      a.id === app.id ? { ...a, businessCategory: targetCat } : a,
    )
    const endpoint =
      app.source === 'project'
        ? `/api/projects/${realProjectId(app.id)}`
        : `/api/portfolio/${app.id}`
    await optimisticPatch(
      next,
      () =>
        fetch(endpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ businessCategory: targetCat }),
        }),
      'カテゴリの変更に失敗しました',
    )
  }

  function appsForOrg(org: OrgNameType): AppPortfolioWithOrgs[] {
    const byUpdatedDesc = (a: AppPortfolioWithOrgs, b: AppPortfolioWithOrgs) =>
      b.updatedAt.localeCompare(a.updatedAt)
    // 手動定義(AppPortfolio)を上、Project 由来を下に表示。各セクション updatedAt DESC。
    const portfolioApps = optimisticApps
      .filter((a) => a.source === 'portfolio' && a.orgMappings.some((m) => m.orgName === org))
      .sort(byUpdatedDesc)
    const projectApps = optimisticApps
      .filter((a) => a.source === 'project' && a.orgMappings.some((m) => m.orgName === org))
      .sort(byUpdatedDesc)
    return [...portfolioApps, ...projectApps]
  }

  function appsForCategory(categoryId: string): AppPortfolioWithOrgs[] {
    return optimisticApps
      .filter((a) => a.businessCategory === categoryId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return (
    <main className="flex flex-col min-h-screen bg-peco-bg">
      <header className="h-14 shrink-0 flex items-center justify-between px-6 bg-white border-b border-peco-gray-300">
        <Link
          href="/"
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          title="ワークスペースに戻る"
        >
          <span className="text-2xl" aria-hidden>📋</span>
          <div>
            <h1 className="text-base font-bold text-peco-text-primary leading-tight">PECO App Portfolio</h1>
            <p className="text-xs text-peco-text-muted">AI VETS事業本部 / 病院事業部</p>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-peco-gray-300 overflow-hidden" role="group" aria-label="表示切替">
            <button
              type="button"
              onClick={() => setViewMode('org')}
              aria-pressed={viewMode === 'org'}
              className={`h-9 px-3 text-sm font-medium transition-colors duration-150 cursor-pointer ${
                viewMode === 'org'
                  ? 'bg-peco-primary text-peco-gray-900'
                  : 'bg-white text-peco-text-secondary hover:bg-peco-gray-50'
              }`}
            >
              組織別 ({optimisticApps.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode('category')}
              aria-pressed={viewMode === 'category'}
              className={`h-9 px-3 text-sm font-medium border-l border-peco-gray-300 transition-colors duration-150 cursor-pointer ${
                viewMode === 'category'
                  ? 'bg-peco-primary text-peco-gray-900'
                  : 'bg-white text-peco-text-secondary hover:bg-peco-gray-50'
              }`}
            >
              カテゴリ別 ({optimisticApps.length})
            </button>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="h-9 px-4 rounded-lg bg-peco-primary text-peco-gray-900 font-semibold text-sm hover:bg-peco-primary-dark hover:brightness-95 active:brightness-90 transition-all duration-150 cursor-pointer"
            >
              + アプリを追加
            </button>
          )}
          <button
            type="button"
            onClick={handleAdminToggle}
            className={`h-9 px-4 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer border ${
              isAdmin
                ? 'bg-peco-danger-light text-peco-danger border-peco-danger hover:opacity-80'
                : 'bg-white text-peco-text-secondary border-peco-gray-300 hover:bg-peco-gray-50 hover:brightness-95 active:brightness-90'
            }`}
          >
            {isAdmin ? '管理者モード解除' : '管理者モード'}
          </button>
          <Link
            href="/"
            className="text-xs text-peco-text-secondary hover:text-peco-primary-dark hover:underline ml-2 cursor-pointer transition-colors duration-150"
          >
            ← ワークスペースへ
          </Link>
        </div>
      </header>

      {isAdmin && (
        <div className="px-6 py-2 bg-peco-warning-light border-b border-peco-warning text-xs text-peco-warning font-medium">
          管理者モード: 組織別ビューとカテゴリ別ビューで D&D による再配置が可能です
        </div>
      )}
      {!isAdmin && viewMode === 'category' && (
        <div className="px-6 py-2 bg-peco-info-light border-b border-peco-info text-xs text-peco-info font-medium">
          カテゴリ別ビュー（読み取り専用）: 手動定義システム + 開発案件を事業カテゴリでグルーピング表示しています
        </div>
      )}

      <div className="flex-1 overflow-hidden flex flex-col">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-3 text-peco-text-muted">
              <span className="inline-block w-5 h-5 rounded-full border-2 border-peco-primary border-t-transparent peco-spin" />
              <span className="text-sm">読み込み中…</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-sm text-peco-danger bg-peco-danger-light rounded-lg px-5 py-3">
              {error}
              <button onClick={() => void fetchApps()} className="ml-3 underline">再試行</button>
            </div>
          </div>
        ) : viewMode === 'category' ? (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex-1 overflow-x-auto px-6 py-5">
              <div className="flex gap-4 min-w-max pb-4">
                {BUSINESS_CATEGORIES.map((category) => (
                  <CategoryColumn
                    key={category.id}
                    category={category}
                    apps={appsForCategory(category.id)}
                    isAdmin={isAdmin}
                    executingByName={executingByName}
                    onExecutingClick={(systemId) => setPartsModalSystem(systemId)}
                  />
                ))}
              </div>
            </div>
            <DragOverlay>
              {activeApp && (
                <AppCard
                  app={activeApp}
                  isAdmin={false}
                  onStatusChange={() => undefined}
                  onOrgChange={() => undefined}
                />
              )}
            </DragOverlay>
          </DndContext>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex-1 overflow-x-auto px-6 py-5">
              <div className="flex gap-4 min-w-max pb-4">
                {ORG_ORDER.map((org) => (
                  <OrgColumn
                    key={org}
                    orgName={org}
                    apps={appsForOrg(org)}
                    isAdmin={isAdmin}
                    onStatusChange={(id, status) => void handleStatusChange(id, status)}
                    onOrgChange={(id, orgs) => void handleOrgChange(id, orgs)}
                    executingByName={executingByName}
                    onExecutingClick={(systemId) => setPartsModalSystem(systemId)}
                  />
                ))}
              </div>
            </div>
            <DragOverlay>
              {activeApp && (
                <AppCard
                  app={activeApp}
                  isAdmin={false}
                  onStatusChange={() => undefined}
                  onOrgChange={() => undefined}
                />
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {dndError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-peco-danger text-white text-sm font-medium shadow-peco-lg peco-fade-in">
          {dndError}
        </div>
      )}

      <div className="px-6 py-3 border-t border-peco-gray-300 flex flex-wrap gap-2 bg-white">
        <button
          type="button"
          onClick={() => setShowChangeLog(true)}
          className="h-9 px-4 rounded-lg border border-peco-gray-300 bg-white text-peco-text-secondary text-sm font-medium hover:bg-peco-gray-50 hover:brightness-95 active:brightness-90 transition-all duration-150 cursor-pointer"
        >
          📋 変更履歴を見る
        </button>
        <button
          type="button"
          onClick={() => setShowTechStack(true)}
          className="h-9 px-4 rounded-lg border border-peco-gray-300 bg-white text-peco-text-secondary text-sm font-medium hover:bg-peco-gray-50 hover:brightness-95 active:brightness-90 transition-all duration-150 cursor-pointer"
        >
          🔧 技術スタックを見る
        </button>
      </div>

      {showChangeLog && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowChangeLog(false)}
        >
          <div
            className="bg-peco-bg border border-peco-gray-300 rounded-peco-lg shadow-peco-lg w-full max-w-3xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-peco-gray-300 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-peco-text-primary">📋 変更履歴</h3>
              <button
                type="button"
                onClick={() => setShowChangeLog(false)}
                className="text-peco-text-muted hover:text-peco-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <ChangeLogPanel apps={apps} />
            </div>
          </div>
        </div>
      )}

      {showTechStack && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowTechStack(false)}
        >
          <div
            className="bg-peco-bg border border-peco-gray-300 rounded-peco-lg shadow-peco-lg w-full max-w-3xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-peco-gray-300 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-peco-text-primary">🔧 技術スタック</h3>
              <button
                type="button"
                onClick={() => setShowTechStack(false)}
                className="text-peco-text-muted hover:text-peco-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <TechStackSummary />
            </div>
          </div>
        </div>
      )}

      {partsModalSystem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPartsModalSystem(null)}
        >
          <div
            className="bg-peco-bg border border-peco-gray-300 rounded-peco-lg shadow-peco-lg w-full max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-peco-gray-300 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-peco-text-primary">
                ⚡ Claude Code実行中{partsModalData?.projectTitle ? ` - ${partsModalData.projectTitle}` : ''}
              </h3>
              <button
                type="button"
                onClick={() => setPartsModalSystem(null)}
                className="text-peco-text-muted hover:text-peco-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-2">
              {partsModalData?.parts.length ? (
                <>
                  {partsModalData.parts.map((p) => {
                    const cls =
                      p.status === 'completed'
                        ? 'bg-peco-success-light text-peco-success'
                        : p.status === 'error'
                          ? 'bg-peco-danger-light text-peco-danger'
                          : p.status === 'executing'
                            ? 'bg-peco-primary-light text-peco-primary-dark'
                            : 'bg-peco-gray-100 text-peco-text-muted'
                    const icon =
                      p.status === 'completed'
                        ? '✅ 完了'
                        : p.status === 'error'
                          ? '❌ エラー'
                          : p.status === 'executing'
                            ? '⚡ 実行中...'
                            : '⏳ 待機中'
                    return (
                      <div
                        key={p.partNumber ?? Math.random()}
                        className={`flex items-center gap-2 px-3 py-2 rounded-peco-sm text-xs ${cls}`}
                      >
                        <span className="font-mono font-semibold">Part{p.partNumber}:</span>
                        <span className="flex-1 truncate">{p.partTitle ?? '（未設定）'}</span>
                        <span className="shrink-0">{icon}</span>
                      </div>
                    )
                  })}
                  {(() => {
                    const total = partsModalData.parts.length
                    const done = partsModalData.parts.filter((p) => p.status === 'completed').length
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0
                    return (
                      <div className="pt-2 text-xs text-peco-text-secondary">
                        全体進捗:
                        <span className="inline-block ml-2 w-40 h-2 rounded-full bg-peco-gray-100 align-middle overflow-hidden">
                          <span
                            className="block h-full bg-peco-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="ml-2 font-mono">{done}/{total} 完了</span>
                      </div>
                    )
                  })()}
                </>
              ) : (
                <div className="text-sm text-peco-text-muted">パート情報が見つかりませんでした。</div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-peco-gray-300 flex justify-end">
              <button
                type="button"
                onClick={() => setPartsModalSystem(null)}
                className="h-9 px-4 rounded-lg border border-peco-gray-300 bg-white text-peco-text-secondary text-sm font-medium hover:bg-peco-gray-50 hover:brightness-95 active:brightness-90 transition-all duration-150 cursor-pointer"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <AddAppModal
          onClose={() => setShowAddModal(false)}
          onCreated={(app) => setApps((prev) => [...prev, app])}
        />
      )}
    </main>
  )
}
