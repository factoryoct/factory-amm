import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'
import { shortenAddress } from '../utils/format'
import { readTheme, applyTheme, type Theme } from '../utils/theme'

const ITEMS = [
  { to: '/',            label: 'swap' },
  { to: '/pool',        label: 'liquidity' },
  { to: '/positions',   label: 'positions' },
  { to: '/leaderboard', label: 'points' },
  { to: '/protocol',    label: 'protocol' },
]

export default function TopNav({ onMenu, compact }: { onMenu?: () => void; compact?: boolean }) {
  const { pathname } = useLocation()
  const { connected, address, openConnectModal, openWalletSidebar, walletSidebarOpen, closeWalletSidebar } = useWallet()
  const [hover, setHover] = useState('')
  const [theme, setTheme] = useState<Theme>(readTheme)
  const flipTheme = () => setTheme(t => { const n: Theme = t === 'dark' ? 'light' : 'dark'; applyTheme(n); return n })

  const bar = useRef<HTMLElement | null>(null)
  const links = useRef<(HTMLAnchorElement | null)[]>([])
  const [mark, setMark] = useState<{ x: number; w: number } | null>(null)
  const activeIdx = ITEMS.findIndex(it => (it.to === '/' ? pathname === '/' : pathname.startsWith(it.to)))
  useEffect(() => {
    const el = activeIdx >= 0 ? links.current[activeIdx] : null
    const read = () => {
      if (!el || el.offsetWidth === 0) { setMark(m => (m === null ? m : null)); return }
      const x = el.offsetLeft
      const w = el.offsetWidth
      setMark(m => (m && m.x === x && m.w === w ? m : { x, w }))
    }
    read()
    const ro = new ResizeObserver(read)
    if (bar.current) ro.observe(bar.current)
    return () => ro.disconnect()
  }, [activeIdx, pathname])

  return (
    <header
      style={{
        flexShrink: 0,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 16,
        padding: '18px 28px 6px',
        background: 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {compact && (
          <button onClick={onMenu} aria-label="menu" style={{ background: 'none', border: 'none', padding: 6, marginLeft: -6, cursor: 'pointer' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--oct-color-text)" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        )}
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none', minWidth: 0 }}>
          <img src="/logo.png" alt="" style={{ height: 22, width: 'auto', display: 'block', flexShrink: 0 }} />
          <span style={{
            fontFamily: 'var(--oct-type-display)', fontSize: 19, fontWeight: 700,
            color: 'var(--oct-color-text)', letterSpacing: '-0.01em',
          }}>factory</span>
        </Link>
      </div>

      {compact ? <span /> : (
        <nav
          ref={bar}
          style={{
            position: 'relative',
            display: 'inline-flex',
            gap: 2,
            padding: 5,
            background: 'var(--oct-color-bg)',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--sh-md)',
          }}
        >
          {mark && (
            <span
              aria-hidden
              style={{
                position: 'absolute', top: 5, height: 34,
                left: mark.x, width: mark.w,
                background: 'var(--oct-color-active)',
                borderRadius: 'calc(var(--r-lg) - 5px)',
                transition: 'left .26s cubic-bezier(.4, 0, .2, 1), width .26s cubic-bezier(.4, 0, .2, 1)',
                pointerEvents: 'none',
              }}
            />
          )}
          {ITEMS.map((it, i) => {
            const active = i === activeIdx
            const hot = hover === it.to && !active
            return (
              <Link
                key={it.to}
                to={it.to}
                ref={el => { links.current[i] = el }}
                onMouseEnter={() => setHover(it.to)}
                onMouseLeave={() => setHover('')}
                style={{
                  position: 'relative', zIndex: 1,
                  display: 'inline-flex', alignItems: 'center',
                  height: 34, padding: '0 16px',
                  borderRadius: 'calc(var(--r-lg) - 5px)',
                  fontSize: 14, fontWeight: active ? 600 : 500,
                  textDecoration: 'none', whiteSpace: 'nowrap', lineHeight: 1,
                  color: active ? 'var(--oct-color-action-ink)' : (hot ? 'var(--oct-color-text)' : 'var(--oct-color-text-2)'),
                  background: hot ? 'var(--oct-color-surface)' : 'transparent',
                  transition: 'background-color .15s ease, color .15s ease',
                }}
              >{it.label}</Link>
            )
          })}
        </nav>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <button
          onClick={flipTheme}
          aria-label={theme === 'dark' ? 'light theme' : 'dark theme'}
          className="ui-ghost"
          style={{ width: 44, height: 44, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {theme === 'dark' ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5Z" />
            </svg>
          )}
        </button>
        {connected ? (
          <button
            onClick={() => (walletSidebarOpen ? closeWalletSidebar() : openWalletSidebar())}
            className="ui-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 16px', fontSize: 13 }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--oct-color-success)' }} />
            <span style={{ fontFamily: 'var(--oct-type-mono)' }}>{shortenAddress(address)}</span>
          </button>
        ) : (
          <button onClick={openConnectModal} className="ui-primary" style={{ height: 44, padding: '0 20px', fontSize: 14 }}>
            connect wallet
          </button>
        )}
      </div>
    </header>
  )
}
