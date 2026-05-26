import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAdminAuth } from '@/lib/admin-auth'
import { isBusinessCategory } from '@/lib/categories'

// AppPortfolio の businessCategory を更新する（カテゴリ別ビューの D&D 用）。
// 組織マッピングは /api/portfolio/[id]/mapping、ステータスは /status が担当する。
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

  if (!('businessCategory' in b)) {
    return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 })
  }
  if (!isBusinessCategory(b.businessCategory)) {
    return NextResponse.json({ error: 'invalid_businessCategory' }, { status: 400 })
  }

  const existing = await prisma.appPortfolio.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await prisma.appPortfolio.update({
    where: { id },
    data: { businessCategory: b.businessCategory },
  })

  return NextResponse.json({ id, businessCategory: b.businessCategory })
}
