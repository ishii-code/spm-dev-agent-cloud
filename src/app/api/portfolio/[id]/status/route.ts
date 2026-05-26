import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAdminAuth } from '@/lib/admin-auth'
import type { AppStatusType } from '@/types/portfolio'

const VALID_STATUSES: AppStatusType[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNDER_REVISION']

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkAdminAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const b = body as Record<string, unknown>

  if (typeof b.status !== 'string' || !VALID_STATUSES.includes(b.status as AppStatusType)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  const newStatus = b.status as AppStatusType
  const changedBy = typeof b.changedBy === 'string' ? b.changedBy.slice(0, 50) : 'admin'

  const existing = await prisma.appPortfolio.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const oldStatus = existing.status as AppStatusType
  if (oldStatus === newStatus) {
    return NextResponse.json({ id, status: newStatus })
  }

  await prisma.$transaction([
    prisma.appPortfolio.update({ where: { id }, data: { status: newStatus } }),
    prisma.portfolioChangeLog.create({
      data: {
        appId: id,
        appName: existing.name,
        changeType: 'STATUS_CHANGE',
        fieldName: 'status',
        oldValue: oldStatus,
        newValue: newStatus,
        changedBy,
      },
    }),
  ])

  return NextResponse.json({ id, status: newStatus })
}
