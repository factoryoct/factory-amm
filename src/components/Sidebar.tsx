import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'
import { shortenAddress } from '../utils/format'

type Item = { to: string; label: string; icon: JSX.Element; disabled?: boolean }
type Group = { title: string; items: Item[] }

const s = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const IconSwap    = <svg {...s}><path d="M7 4v13" /><path d="m4 14 3 3 3-3" /><path d="M17 20V7" /><path d="m14 10 3-3 3 3" /></svg>
const IconPool    = <svg {...s}><path d="M3 12s2-3 4.5-3S12 12 12 12s2-3 4.5-3S21 12 21 12" /><path d="M3 17s2-3 4.5-3S12 17 12 17s2-3 4.5-3S21 17 21 17" /><path d="M3 7s2-3 4.5-3S12 7 12 7s2-3 4.5-3S21 7 21 7" /></svg>
const IconWallet  = <svg {...s}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18" /><circle cx="17" cy="14.5" r="1.2" /></svg>
const IconPoints  = <svg {...s}><path d="m12 4 2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.6-4.6 2.6.9-5.3L4.5 9.6l5.2-.7Z" /></svg>

const GROUPS: Group[] = [
  { title: 'trade', items: [
    { to: '/',          label: 'swap',      icon: IconSwap },
  ] },
  { title: 'earn', items: [
    { to: '/pool',        label: 'liquidity', icon: IconPool },
    { to: '/positions',   label: 'positions', icon: IconWallet },
    { to: '/leaderboard', label: 'points',    icon: IconPoints },
  ] },
]

const SIDEBAR_W = 236

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const { connected, address, openConnectModal, openWalletSidebar, walletSidebarOpen, closeWalletSidebar } = useWallet()
  const [hover, setHover] = useState('')

  return (
    <aside
      style={{
        width: SIDEBAR_W, flexShrink: 0, height: '100%',
        display: 'flex', flexDirection: 'column',
        background: 'transparent',
      }}
    >
      <Link
        to="/"
        onClick={onNavigate}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '22px 20px 18px', textDecoration: 'none', flexShrink: 0,
        }}
      >
        <img src="/logo.png" alt="" style={{ height: 24, width: 'auto', display: 'block' }} />
        <span style={{
          fontFamily: 'var(--oct-type-display)', fontSize: 20, fontWeight: 700,
          color: 'var(--oct-color-text)', letterSpacing: '-0.01em',
        }}>factory</span>
      </Link>

      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 12px' }}>
        {GROUPS.map(g => (
          <div key={g.title} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#9aa7bd',
              padding: '0 10px 8px', letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>{g.title}</div>
            {g.items.map(it => {
              const active = pathname === it.to || (it.to !== '/' && pathname.startsWith(it.to))
              const hot = hover === it.to && !active && !it.disabled
              return it.disabled ? (
                <span
                  key={it.to}
                  title="coming soon"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 11px', borderRadius: 'var(--r-sm)',
                    fontSize: 14.5, color: 'var(--oct-color-faint)', cursor: 'not-allowed',
                  }}
                >{it.icon}{it.label}</span>
              ) : (
                <Link
                  key={it.to}
                  to={it.to}
                  onClick={onNavigate}
                  onMouseEnter={() => setHover(it.to)}
                  onMouseLeave={() => setHover('')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 11px', borderRadius: 'var(--r-sm)',
                    fontSize: 14.5, fontWeight: active ? 600 : 500,
                    textDecoration: 'none',
                    color: active ? 'var(--oct-color-text)' : (hot ? 'var(--oct-color-text)' : 'var(--oct-color-text-2)'),
                    background: active ? 'var(--oct-color-bg)' : (hot ? 'rgba(255,255,255,.6)' : 'transparent'),
                    boxShadow: active ? 'var(--sh-sm)' : 'none',
                    transition: 'background-color .15s ease, color .15s ease, box-shadow .15s ease',
                  }}
                >
                  <span style={{ color: active ? 'var(--oct-color-primary)' : 'inherit', display: 'inline-flex' }}>{it.icon}</span>
                  {it.label}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div style={{ padding: 12, flexShrink: 0 }}>
        {connected ? (
          <button
            onClick={() => (walletSidebarOpen ? closeWalletSidebar() : openWalletSidebar())}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 11px', textAlign: 'left',
              background: 'var(--oct-color-bg)', border: 'none',
              borderRadius: 'var(--r-md)', cursor: 'pointer', boxShadow: 'var(--sh-sm)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--oct-color-success)', flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontFamily: 'var(--oct-type-mono)', color: 'var(--oct-color-text)' }}>
                {shortenAddress(address)}
              </span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--oct-color-muted)' }}>devnet</span>
            </span>
          </button>
        ) : (
          <button onClick={openConnectModal} className="ui-primary" style={{ width: '100%', padding: '11px 14px', fontSize: 14 }}>
            connect wallet
          </button>
        )}
      </div>
    </aside>
  )
}
