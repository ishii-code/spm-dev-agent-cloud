'use client'

import { useState, useRef, useEffect } from 'react'
import type { AppStatusType } from '@/types/portfolio'
import { STATUS_LABELS, STATUS_COLORS } from '@/types/portfolio'

const ALL_STATUSES: AppStatusType[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNDER_REVISION']

interface Props {
  status: AppStatusType
  isEditable?: boolean
  onChange?: (status: AppStatusType) => void
}

export function StatusBadge({ status, isEditable = false, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const badge = (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )

  if (!isEditable) return badge

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus:outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 left-0 min-w-32 bg-white rounded-lg shadow-lg border border-peco-gray-300 py-1"
          role="listbox"
        >
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={s === status}
              onClick={() => {
                setOpen(false)
                onChange?.(s)
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-peco-gray-50 flex items-center gap-2 ${s === status ? 'font-semibold' : ''}`}
            >
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[s]}`}>
                {STATUS_LABELS[s]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
