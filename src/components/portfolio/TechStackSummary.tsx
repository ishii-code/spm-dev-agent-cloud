export function TechStackSummary() {
  const rows = [
    { label: 'フレームワーク', value: 'Next.js 15 App Router' },
    { label: '言語', value: 'TypeScript (strict)' },
    { label: 'データベース', value: 'PostgreSQL + Prisma ORM' },
    { label: 'AIエンジン', value: 'Anthropic Claude (claude-opus-4-5)' },
    { label: 'UIライブラリ', value: 'Tailwind CSS + shadcn/ui' },
    { label: '認証', value: '簡易管理者認証 (env)' },
    {
      label: 'ポート一覧',
      value: '3000:SPM Dev Agent / 3001:SFA / 3002:診断支援 / 3003:PecoStock / 3004:peco-property / 3005:peco-ui',
    },
  ]

  return (
    <div className="border border-peco-gray-300 rounded-xl overflow-hidden">
      <div className="px-5 py-3 bg-peco-gray-50 border-b border-peco-gray-300">
        <h3 className="font-semibold text-sm text-peco-text-primary">技術スタックサマリー</h3>
      </div>
      <div className="divide-y divide-peco-gray-100">
        {rows.map((row) => (
          <div key={row.label} className="flex px-5 py-2.5 gap-4">
            <dt className="text-xs font-medium text-peco-text-muted w-36 shrink-0">{row.label}</dt>
            <dd className="text-xs text-peco-text-primary">{row.value}</dd>
          </div>
        ))}
      </div>
    </div>
  )
}
