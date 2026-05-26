'use client'

import { useState } from 'react'
import type { AppPortfolioWithOrgs, AppStatusType, OrgNameType } from '@/types/portfolio'
import { STATUS_LABELS, ORG_LABELS, ORG_ORDER } from '@/types/portfolio'

interface Props {
  onClose: () => void
  onCreated: (app: AppPortfolioWithOrgs) => void
}

const STATUS_OPTIONS: AppStatusType[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNDER_REVISION']

export function AddAppModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<AppStatusType>('NOT_STARTED')
  const [techStack, setTechStack] = useState('')
  const [portNumber, setPortNumber] = useState('')
  const [orgNames, setOrgNames] = useState<OrgNameType[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function toggleOrg(org: OrgNameType) {
    setOrgNames((prev) =>
      prev.includes(org) ? prev.filter((o) => o !== org) : [...prev, org],
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) {
      setError('アプリ名は必須です')
      return
    }
    const port = portNumber ? parseInt(portNumber, 10) : null
    if (portNumber && (isNaN(port!) || port! <= 0 || port! >= 65536)) {
      setError('ポート番号は1〜65535で入力してください')
      return
    }

    setLoading(true)
    try {
      const token = sessionStorage.getItem('adminToken') ?? ''
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ name: name.trim(), description, status, techStack, portNumber: port, orgNames }),
      })
      if (res.status === 401) {
        setError('認証エラー。管理者モードに再ログインしてください。')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as Record<string, unknown>
        setError(typeof data.error === 'string' ? data.error : '作成に失敗しました')
        return
      }
      const app = await res.json() as AppPortfolioWithOrgs
      onCreated(app)
      onClose()
    } catch {
      setError('ネットワークエラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 peco-modal-in">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-peco-text-primary">アプリを追加</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-peco-text-muted hover:text-peco-text-primary text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-1">
              アプリ名 <span className="text-peco-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="w-full border border-peco-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-peco-primary"
              placeholder="例: 新規予約システム"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-1">用途説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full border border-peco-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-peco-primary resize-none"
              placeholder="このアプリの説明"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-1">ステータス</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AppStatusType)}
              className="w-full border border-peco-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-peco-primary bg-white"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-1">技術スタック</label>
            <input
              type="text"
              value={techStack}
              onChange={(e) => setTechStack(e.target.value)}
              maxLength={200}
              className="w-full border border-peco-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-peco-primary"
              placeholder="例: Next.js / PostgreSQL / Prisma"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-1">ポート番号（任意）</label>
            <input
              type="number"
              value={portNumber}
              onChange={(e) => setPortNumber(e.target.value)}
              min={1}
              max={65535}
              className="w-full border border-peco-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-peco-primary"
              placeholder="例: 3006"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-peco-text-primary mb-2">紐づけ組織</label>
            <div className="flex flex-wrap gap-2">
              {ORG_ORDER.map((org) => (
                <label key={org} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={orgNames.includes(org)}
                    onChange={() => toggleOrg(org)}
                    className="accent-peco-primary w-4 h-4"
                  />
                  <span className="text-sm text-peco-text-secondary">{ORG_LABELS[org]}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="text-sm text-peco-danger bg-peco-danger-light rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-lg border border-peco-gray-300 text-sm text-peco-text-secondary hover:bg-peco-gray-50 transition-colors"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={loading}
              className="h-10 px-5 rounded-lg bg-peco-primary text-peco-gray-900 font-semibold text-sm hover:bg-peco-primary-dark transition-colors disabled:opacity-60"
            >
              {loading ? '作成中…' : '作成'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
