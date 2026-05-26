import type { BusinessCategoryId } from '@/lib/categories'

export type AppStatusType = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNDER_REVISION'
export type OrgNameType = 'CLINIC_DEV' | 'OPERATIONS' | 'MARKETING' | 'HR' | 'PRODUCT' | 'BACK_OFFICE' | 'UNASSIGNED'

export const STATUS_LABELS: Record<AppStatusType, string> = {
  NOT_STARTED: '未実装',
  IN_PROGRESS: '実装中',
  COMPLETED: '実装済み',
  UNDER_REVISION: '改修中',
}

export const STATUS_COLORS: Record<AppStatusType, string> = {
  NOT_STARTED: 'bg-gray-100 text-gray-600',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  UNDER_REVISION: 'bg-yellow-100 text-yellow-700',
}

export const ORG_LABELS: Record<OrgNameType, string> = {
  CLINIC_DEV: 'ClinicDev',
  OPERATIONS: 'Operations',
  MARKETING: 'Marketing',
  HR: 'HR',
  PRODUCT: 'Product',
  BACK_OFFICE: 'BackOffice',
  UNASSIGNED: '未割り当て',
}

export const ORG_ORDER: OrgNameType[] = [
  'CLINIC_DEV', 'OPERATIONS', 'MARKETING', 'HR', 'PRODUCT', 'BACK_OFFICE', 'UNASSIGNED'
]

// アプリの出所。portfolio = 手動定義(AppPortfolio) / project = Project テーブル由来
export type AppSourceType = 'portfolio' | 'project'

export interface AppPortfolioWithOrgs {
  id: string
  name: string
  description: string
  status: AppStatusType
  techStack: string
  portNumber: number | null
  isFromCode: boolean
  businessCategory: BusinessCategoryId
  source: AppSourceType
  // project 由来のときのみ。parallelStatus から導出した表示用ステータス（絵文字+ラベル）
  projectStatusLabel: string | null
  orgMappings: { orgName: OrgNameType }[]
  createdAt: string
  updatedAt: string
}

export interface PortfolioChangeLogEntry {
  id: string
  appId: string
  appName: string
  changeType: 'STATUS_CHANGE' | 'ORG_MAPPING_CHANGE'
  fieldName: string
  oldValue: string
  newValue: string
  changedBy: string
  changedAt: string
}
