import { useWallet } from '../context/WalletContext'

export default function ToastContainer() {
  const { toasts, removeToast, busy } = useWallet()
  const showSpinner = busy
  const visibleToasts = toasts.filter(t => t.type !== 'pending')

  if (!visibleToasts.length && !showSpinner) return null

  return (
    <div style={{
      position: 'fixed', bottom: 'calc(var(--oct-ticker-h, 0px) + 16px)', left: 16, zIndex: 50,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
    }}>

      {visibleToasts.map(t => (
        <div
          key={t.id}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '10px 14px',
            background: 'var(--oct-color-surface)',
            border: `1px solid ${
              t.type === 'success' ? 'var(--oct-color-success)'
              : t.type === 'error' ? 'var(--oct-color-danger)'
              : 'var(--oct-color-border)'
            }`,
            color: t.type === 'success' ? 'var(--oct-color-success)'
              : t.type === 'error' ? 'var(--oct-color-danger)'
              : 'var(--oct-color-text)',
            fontSize: 12, maxWidth: 280,
            boxShadow: '0 2px 8px rgba(0,0,0,0.07)',
            fontFamily: 'var(--oct-type-ui)',
          }}
        >
          <span style={{ marginTop: 1, fontSize: 11 }}>
            {t.type === 'pending' ? '·' : t.type === 'success' ? '✓' : '✕'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0 }}>{t.message}</p>
            {t.txHash && (
              <a
                href={`https://devnet.octrascan.io/tx.html?hash=${t.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--oct-color-muted)', fontSize: 11,
                  display: 'block', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {t.txHash.slice(0, 20)}...
              </a>
            )}
          </div>
          <button
            onClick={() => removeToast(t.id)}
            style={{
              color: 'var(--oct-color-muted)', background: 'none',
              border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 12, marginLeft: 4, lineHeight: 1,
            }}
          >✕</button>
        </div>
      ))}

      {showSpinner && (
        <div style={{
          width: 32, height: 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          alignSelf: 'flex-start',
        }}>
          <svg
            width="22" height="22" viewBox="0 0 22 22"
            style={{ animation: 'oct-spin 0.75s linear infinite', display: 'block' }}
          >
            <circle cx="11" cy="11" r="9" fill="none" stroke="var(--oct-color-border)" strokeWidth="2.5" />
            <path
              d="M11 2 A9 9 0 0 1 20 11"
              fill="none"
              stroke="var(--oct-color-primary)"
              strokeWidth="2.5"
              strokeLinecap="square"
            />
          </svg>
        </div>
      )}

    </div>
  )
}
