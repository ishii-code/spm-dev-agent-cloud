'use client'

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <html lang="ja">
      <body>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '8px' }}>予期しないエラーが発生しました</h1>
            <p style={{ fontSize: '14px', color: '#555', marginBottom: '16px' }}>{error.message}</p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={unstable_retry}
                style={{ display: 'inline-block', padding: '8px 20px', background: '#FCB900', borderRadius: '8px', fontWeight: '600', fontSize: '14px', border: 'none', cursor: 'pointer', color: '#1A1A1A' }}
              >
                再試行
              </button>
              <a
                href="/"
                style={{ display: 'inline-block', padding: '8px 20px', background: '#f3f4f6', borderRadius: '8px', fontWeight: '600', fontSize: '14px', textDecoration: 'none', color: '#1A1A1A' }}
              >
                ホームへ戻る
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
