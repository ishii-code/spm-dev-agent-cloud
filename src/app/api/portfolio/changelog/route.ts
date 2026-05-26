import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { PortfolioChangeLogEntry } from '@/types/portfolio'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const appId = searchParams.get('appId')

  const logs = await prisma.portfolioChangeLog.findMany({
    where: appId ? { appId } : undefined,
    orderBy: { changedAt: 'desc' },
    take: 50,
  })

  const result: PortfolioChangeLogEntry[] = logs.map((l) => ({
    id: l.id,
    appId: l.appId,
    appName: l.appName,
    changeType: l.changeType as 'STATUS_CHANGE' | 'ORG_MAPPING_CHANGE',
    fieldName: l.fieldName,
    oldValue: l.oldValue,
    newValue: l.newValue,
    changedBy: l.changedBy,
    changedAt: l.changedAt.toISOString(),
  }))

  return NextResponse.json(result)
}
