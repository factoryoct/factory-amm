import { ReactNode } from 'react'

export default function PageHead(p: {
  title: string
  lead?: ReactNode
  actions?: ReactNode
  busy?: boolean
  stats?: { label: string; value: ReactNode; tone?: 'up' | 'down' }[]
}) {
  return (
    <header style={{ marginBottom: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 24, flexWrap: 'wrap', minHeight: 44,
      }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{
            fontFamily: 'var(--oct-type-display)', fontSize: 28, fontWeight: 600,
            letterSpacing: '-0.02em', lineHeight: 1.12, margin: 0,
            color: 'var(--oct-color-text)',
            display: 'inline-flex', alignItems: 'center', gap: 12,
          }}>
            {p.title}
            {p.busy && (
              <svg className="oct-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-label="loading">
                <circle cx="12" cy="12" r="9" stroke="var(--oct-color-border-strong)" strokeWidth="2.6" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--oct-color-primary)" strokeWidth="2.6" strokeLinecap="round" />
              </svg>
            )}
          </h1>
          {p.lead && (
            <p style={{
              margin: '7px 0 0', fontSize: 14, lineHeight: 1.6,
              color: 'var(--oct-color-text-2)', maxWidth: 620,
            }}>{p.lead}</p>
          )}
        </div>
        {p.actions && <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>{p.actions}</div>}
      </div>

      {p.stats && p.stats.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 0, marginTop: 20,
          border: '1px solid var(--oct-color-border)', borderRadius: 'var(--r-md)',
          background: 'var(--oct-color-bg)', overflow: 'hidden',
        }}>
          {p.stats.map((st, i) => (
            <div key={st.label} style={{
              flex: '1 1 160px', padding: '14px 18px',
              borderLeft: i === 0 ? 'none' : '1px solid var(--oct-color-border)',
            }}>
              <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', marginBottom: 4 }}>{st.label}</div>
              <div style={{
                fontFamily: 'var(--oct-type-mono)', fontSize: 21, fontWeight: 500,
                letterSpacing: '-0.01em',
                color: st.tone === 'up' ? 'var(--oct-color-success)'
                     : st.tone === 'down' ? 'var(--oct-color-danger)'
                     : 'var(--oct-color-text)',
              }}>{st.value}</div>
            </div>
          ))}
        </div>
      )}
    </header>
  )
}

export function Page({ children, width = 1200 }: { children: ReactNode; width?: number }) {
  return (
    <div style={{ padding: '8px 32px 72px' }}>
      <div style={{ maxWidth: width, margin: '0 auto' }}>{children}</div>
    </div>
  )
}
