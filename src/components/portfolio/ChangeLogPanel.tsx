'use client'

import { useState, useEffect, useCallback } from 'react'
import type { PortfolioChangeLogEntry, AppPortfolioWithOrgs } from '@/types/portfolio'

interface Props {
  apps: AppPortfolioWithOrgs[]
}

export function ChangeLogPanel({ apps }: Props) {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<PortfolioChangeLogEntry[]>([])
  const [filterAppId, setFilterAppId] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const url = filterAppId ? `/api/portfolio/changelog?appId=${encodeURIComponent(filterAppId)}` : '/api/portfolio/changelog'
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json() as PortfolioChangeLogEntry[]
        setLogs(data)
      }
    } finally {
      setLoading(false)
    }
  }, [filterAppId])

  useEffect(() => {
    if (open) void fetchLogs()
  }, [open, fetchLogs])

  function formatDate(iso: string) {
    const d = new Date(iso)
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function changeTypeLabel(t: string) {
    if (t === 'STATUS_CHANGE') return 'ステータス変更'
    if (t === 'ORG_MAPPING_CHANGE') return '組織変更'
    return t
  }

  return (
    <div className="border border-peco-gray-300 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 bg-peco-gray-50 hover:bg-peco-gray-100 transition-colors text-left"
      >
        <span className="font-semibold text-sm text-peco-text-primary">変更履歴</span>
        <svg
          className={`w-4 h-4 text-peco-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <label className="text-sm text-peco-text-secondary shrink-0">アプリ絞り込み:</label>
            <select
              value={filterAppId}
              onChange={(e) => setFilterAppId(e.target.value)}
              className="border border-peco-gray-300 rounded-lg px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-peco-primary"
            >
              <option value="">全て</option>
              {apps.map((app) => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="text-sm text-peco-text-muted py-4 text-center">読み込み中…</div>
          ) : logs.length === 0 ? (
            <div className="text-sm text-peco-text-muted py-4 text-center">変更履歴がありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-peco-gray-300">
                    <th className="text-left py-2 pr-3 text-peco-text-muted font-medium">アプリ名</th>
                    <th className="text-left py-2 pr-3 text-peco-text-muted font-medium">変更種別</th>
                    <th className="text-left py-2 pr-3 text-peco-text-muted font-medium">変更前</th>
                    <th className="text-left py-2 pr-3 text-peco-text-muted font-medium">変更後</th>
                    <th className="text-left py-2 pr-3 text-peco-text-muted font-medium">変更者</th>
                    <th className="text-left py-2 text-peco-text-muted font-medium">日時</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-peco-gray-100 hover:bg-peco-gray-50">
                      <td className="py-2 pr-3 text-peco-text-primary font-medium truncate max-w-32">{log.appName}</td>
                      <td className="py-2 pr-3 text-peco-text-secondary">{changeTypeLabel(log.changeType)}</td>
                      <td className="py-2 pr-3 text-peco-text-muted">{log.oldValue}</td>
                      <td className="py-2 pr-3 text-peco-text-secondary">{log.newValue}</td>
                      <td className="py-2 pr-3 text-peco-text-muted">{log.changedBy}</td>
                      <td className="py-2 text-peco-text-muted whitespace-nowrap">{formatDate(log.changedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
