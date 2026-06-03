import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAdminAuth } from '@/lib/admin-auth'
import type { AppPortfolioWithOrgs, AppStatusType, OrgNameType } from '@/types/portfolio'
import type { BusinessCategoryId } from '@/lib/categories'

// Project.parallelStatus + ドキュメント有無から、カテゴリ別ビュー用の表示ステータスを導出する。
// status は AppCard のバッジ流用のための AppStatusType、label は仕様書のアイコン+ラベル。
function deriveProjectStatus(
  parallelStatus: string | null,
  hasSprintDoc: boolean,
): { status: AppStatusType; label: string } {
  switch (parallelStatus) {
    case 'done':
      return { status: 'COMPLETED', label: '✅ 完成' }
    case 'running':
    case 'executing':
      return { status: 'IN_PROGRESS', label: '⚡ 開発中' }
    case 'scaffolding':
    case 'scaffolding_active':
      return { status: 'IN_PROGRESS', label: '🛠️ 準備中' }
    case 'scaffold_error':
      return { status: 'UNDER_REVISION', label: '⚠️ 準備失敗' }
    case 'paused':
      return { status: 'UNDER_REVISION', label: '⏸️ 一時停止' }
    default:
      return hasSprintDoc
        ? { status: 'NOT_STARTED', label: '📝 設計中' }
        : { status: 'NOT_STARTED', label: '🆕 新規' }
  }
}

export async function GET() {
  const apps = await prisma.appPortfolio.findMany({
    include: { orgMappings: { select: { orgName: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const portfolioApps: AppPortfolioWithOrgs[] = apps.map((app) => ({
    id: app.id,
    name: app.name,
    description: app.description,
    status: app.status as AppStatusType,
    techStack: app.techStack,
    portNumber: app.portNumber,
    isFromCode: app.isFromCode,
    businessCategory: app.businessCategory as BusinessCategoryId,
    source: 'portfolio',
    projectStatusLabel: null,
    orgMappings: app.orgMappings.map((m) => ({ orgName: m.orgName as OrgNameType })),
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  }))

  // Project テーブルの未アーカイブ案件を統一型へマップして合算（カテゴリ別ビューで使用）
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      title: true,
      description: true,
      parallelStatus: true,
      businessCategory: true,
      orgName: true,
      createdAt: true,
      updatedAt: true,
      documents: { select: { type: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })

  const projectApps: AppPortfolioWithOrgs[] = projects.map((p) => {
    const hasSprintDoc = p.documents.some((d) => d.type === 'sprint')
    const { status, label } = deriveProjectStatus(p.parallelStatus, hasSprintDoc)
    // orgName を組織別ビュー用に orgMappings へ反映（未設定は UNASSIGNED 扱い）
    const orgName = (p.orgName ?? 'UNASSIGNED') as OrgNameType
    return {
      id: `project:${p.id}`,
      name: p.title,
      description: p.description ?? '',
      status,
      techStack: '',
      portNumber: null,
      isFromCode: false,
      businessCategory: p.businessCategory as BusinessCategoryId,
      source: 'project',
      projectStatusLabel: label,
      orgMappings: [{ orgName }],
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }
  })

  return NextResponse.json([...portfolioApps, ...projectApps])
}

interface PostBody {
  name: string
  description?: string
  status?: AppStatusType
  techStack?: string
  portNumber?: number | null
  orgNames?: OrgNameType[]
}

export async function POST(request: Request) {
  if (!checkAdminAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  if (typeof b.name !== 'string' || b.name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (b.name.length > 100) {
    return NextResponse.json({ error: 'name too long' }, { status: 400 })
  }
  const description = typeof b.description === 'string' ? b.description.slice(0, 500) : ''
  const techStack = typeof b.techStack === 'string' ? b.techStack.slice(0, 200) : ''
  const portNumber =
    typeof b.portNumber === 'number' && b.portNumber > 0 && b.portNumber < 65536
      ? b.portNumber
      : null
  const status: AppStatusType =
    typeof b.status === 'string' &&
    ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNDER_REVISION'].includes(b.status)
      ? (b.status as AppStatusType)
      : 'NOT_STARTED'
  const orgNames: OrgNameType[] = Array.isArray(b.orgNames)
    ? (b.orgNames as unknown[]).filter(
        (o): o is OrgNameType =>
          typeof o === 'string' &&
          ['CLINIC_DEV', 'OPERATIONS', 'MARKETING', 'HR', 'PRODUCT', 'BACK_OFFICE', 'UNASSIGNED'].includes(o),
      )
    : []

  const typed = body as PostBody
  void typed

  const app = await prisma.appPortfolio.create({
    data: {
      name: b.name.trim(),
      description,
      status,
      techStack,
      portNumber,
      isFromCode: false,
      orgMappings: {
        create: orgNames.map((orgName) => ({ orgName })),
      },
    },
    include: { orgMappings: { select: { orgName: true } } },
  })

  const result: AppPortfolioWithOrgs = {
    id: app.id,
    name: app.name,
    description: app.description,
    status: app.status as AppStatusType,
    techStack: app.techStack,
    portNumber: app.portNumber,
    isFromCode: app.isFromCode,
    businessCategory: app.businessCategory as BusinessCategoryId,
    source: 'portfolio',
    projectStatusLabel: null,
    orgMappings: app.orgMappings.map((m) => ({ orgName: m.orgName as OrgNameType })),
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  }

  return NextResponse.json(result)
}
