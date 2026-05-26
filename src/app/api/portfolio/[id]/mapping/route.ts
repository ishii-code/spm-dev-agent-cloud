import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAdminAuth } from '@/lib/admin-auth'
import type { OrgNameType } from '@/types/portfolio'

const VALID_ORGS: OrgNameType[] = [
  'CLINIC_DEV', 'OPERATIONS', 'MARKETING', 'HR', 'PRODUCT', 'BACK_OFFICE', 'UNASSIGNED',
]

export async function POST(
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

  if (!Array.isArray(b.orgNames)) {
    return NextResponse.json({ error: 'orgNames must be an array' }, { status: 400 })
  }
  const orgNames: OrgNameType[] = (b.orgNames as unknown[]).filter(
    (o): o is OrgNameType => typeof o === 'string' && VALID_ORGS.includes(o as OrgNameType),
  )
  const changedBy = typeof b.changedBy === 'string' ? b.changedBy.slice(0, 50) : 'admin'

  const existing = await prisma.appPortfolio.findUnique({
    where: { id },
    include: { orgMappings: { select: { orgName: true } } },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const oldOrgs = existing.orgMappings.map((m) => m.orgName).join(', ') || '(なし)'
  const newOrgs = orgNames.join(', ') || '(なし)'

  await prisma.$transaction([
    prisma.orgAppMapping.deleteMany({ where: { appId: id } }),
    prisma.orgAppMapping.createMany({
      data: orgNames.map((orgName) => ({ appId: id, orgName })),
    }),
    prisma.portfolioChangeLog.create({
      data: {
        appId: id,
        appName: existing.name,
        changeType: 'ORG_MAPPING_CHANGE',
        fieldName: 'orgMappings',
        oldValue: oldOrgs,
        newValue: newOrgs,
        changedBy,
      },
    }),
  ])

  return NextResponse.json({ id, orgNames })
}
