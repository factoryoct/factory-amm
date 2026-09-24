import { useEffect, useState, useCallback } from 'react'
import Segmented from '../components/Segmented'
import PageHead, { Page } from '../components/PageHead'
import { useWallet } from '../context/WalletContext'
import { shortenAddress } from '../utils/format'
import { getLeaderboard, getPoints, getReferralCode, type LeaderRow, type LeaderCategory, type PointsInfo } from '../utils/points'
import { useIsMobile } from '../hooks/useMediaQuery'

const F = 'var(--oct-type-ui)'
const M = 'var(--oct-type-mono)'

const CATEGORIES: { key: LeaderCategory; label: string; col: string; fmt: (r: LeaderRow) => string }[] = [
  { key: 'overall',   label: 'overall',   col: 'points',    fmt: r => r.total.toLocaleString() },
  { key: 'liquidity', label: 'liquidity', col: 'liq points', fmt: r => r.liquidity.toLocaleString() },
  { key: 'swaps',     label: 'swaps',     col: 'swaps',     fmt: r => String(r.swaps) },
  { key: 'volume',    label: 'volume',    col: 'volume',    fmt: r => (r.volume / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
]

const TIER_COLOR: Record<string, string> = {
  diamond: '#2f9fc4', platinum: '#5b7fb0', gold: 'var(--oct-color-warning)', silver: 'var(--oct-color-muted)', bronze: '#9c7a5a',
}

export default function Leaderboard() {
  const { address, connected, addToast } = useWallet()
  const isMobile = useIsMobile()
  const [refCode, setRefCode] = useState<string | null>(null)
  const refLink = refCode ? `${window.location.origin}/?ref=${refCode}` : ''
  const copyRefLink = async () => {
    if (!refLink) return
    try {
      await navigator.clipboard.writeText(refLink)
      addToast({ type: 'success', message: 'referral link copied' })
    } catch {
      addToast({ type: 'error', message: 'copy failed' })
    }
  }
  const [cat, setCat] = useState<LeaderCategory>('overall')
  const [rows, setRows] = useState<LeaderRow[]>([])
  const [me, setMe] = useState<PointsInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [lb, mine] = await Promise.all([
      getLeaderboard(cat, 100),
      connected && address ? getPoints(address) : Promise.resolve(null),
    ])
    setRows(lb); setMe(mine); setLoading(false)
  }, [cat, connected, address])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    if (connected && address) getReferralCode(address).then(c => { if (!cancelled) setRefCode(c) })
    else setRefCode(null)
    return () => { cancelled = true }
  }, [connected, address])

  const active = CATEGORIES.find(c => c.key === cat)!
  const myRank = me ? rows.findIndex(r => r.wallet === address) + 1 : 0

  const card = { background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '24px 28px' }
  const labelStyle = { fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', textTransform: 'uppercase' as const, marginBottom: 10 }
  const bigVal = { fontFamily: M, fontSize: 26, color: 'var(--oct-color-text)', letterSpacing: '-0.5px' }

  return (
    <Page>
      <PageHead
        title="points"
      />

      {connected && me && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 32 }}>
          <div style={card}>
            <div style={labelStyle}>your points</div>
            <div style={bigVal}>{me.total.toLocaleString()}</div>
          </div>
          <div style={card}>
            <div style={labelStyle}>your rank ({active.label})</div>
            <div style={bigVal}>{myRank > 0 ? `#${myRank}` : 'n/a'}</div>
          </div>
          <div style={card}>
            <div style={labelStyle}>streak</div>
            <div style={bigVal}>{me.streak}d <span style={{ fontSize: 16, color: 'var(--oct-color-primary)' }}>×{me.streakMult.toFixed(2)}</span></div>
          </div>
          <div style={card}>
            <div style={labelStyle}>tier</div>
            <div style={{ ...bigVal, color: TIER_COLOR[me.tier] || 'var(--oct-color-text)', textTransform: 'capitalize' }}>{me.tier}</div>
          </div>
        </div>
      )}

      {connected && address && (
        <div style={{ ...card, marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={labelStyle as any}>your referral link</span>
            {me && me.referralCount > 0 && (
              <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-primary)' }}>
                {me.referralCount} referred
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            <div style={{
              flex: 1, fontFamily: M, fontSize: 13, color: refLink ? 'var(--oct-color-text)' : 'var(--oct-color-faint)',
              background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '10px 14px',
              display: 'flex', alignItems: 'center',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: refLink ? 'all' : 'none',
            }}>
              {refLink || 'generating your link…'}
            </div>
            <button onClick={copyRefLink} disabled={!refLink} style={{
              fontFamily: F, fontSize: 14, fontWeight: 600, color: 'var(--oct-color-action-ink)', padding: '0 22px',
              background: 'var(--oct-color-action)', border: 'none', cursor: refLink ? 'pointer' : 'not-allowed',
              opacity: refLink ? 1 : 0.5, letterSpacing: '0.5px',
            }}>copy link</button>
          </div>
          <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', marginTop: 12, lineHeight: 1.5 }}>
            invite friends and earn 10% of their points. share your link, they connect their wallet from it, and it binds automatically.
          </div>
        </div>
      )}

      <div style={{ marginBottom: 22 }}>
        <Segmented
          height={30}
          value={cat}
          onChange={v => setCat(v)}
          items={CATEGORIES.map(c => ({ value: c.key, label: c.label }))}
        />
      </div>

      <div className={isMobile ? '' : 'm-scroll'} style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)' }}>
        {!isMobile && (
          <div className="lb-grid" style={{ display: 'grid', padding: '12px 20px', borderBottom: '1px solid var(--oct-color-border)', fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            <div>rank</div><div>wallet</div><div style={{ textAlign: 'right' }}>{active.col}</div><div style={{ textAlign: 'right' }}>streak</div><div style={{ textAlign: 'right' }}>tier</div>
          </div>
        )}
        {loading ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>no points yet, be the first to farm</div>
        ) : rows.map(r => {
          const mine = r.wallet === address
          if (isMobile) return (
            <div key={r.wallet} style={{ padding: '13px 16px', borderBottom: '1px solid var(--oct-color-border)', background: mine ? 'var(--oct-color-surface)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
                <span style={{ fontFamily: M, fontSize: 15, color: r.rank <= 3 ? 'var(--oct-color-warning)' : 'var(--oct-color-muted)', fontWeight: r.rank <= 3 ? 700 : 400 }}>#{r.rank}</span>
                <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)' }}>{shortenAddress(r.wallet)}</span>
                {mine && <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-primary)' }}>you</span>}
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)' }}>
                <span><span style={{ fontFamily: F, color: 'var(--oct-color-muted)' }}>{active.col} </span>{active.fmt(r)}</span>
                <span><span style={{ fontFamily: F, color: 'var(--oct-color-muted)' }}>streak </span><span style={{ color: r.streak > 0 ? 'var(--oct-color-primary)' : 'var(--oct-color-faint)' }}>{r.streak}d</span></span>
                <span><span style={{ fontFamily: F, color: 'var(--oct-color-muted)' }}>tier </span><span style={{ color: TIER_COLOR[r.tier] || 'var(--oct-color-muted)', textTransform: 'capitalize' }}>{r.tier}</span></span>
              </div>
            </div>
          )
          return (
            <div key={r.wallet} className="lb-grid" style={{
              display: 'grid', padding: '12px 20px',
              borderBottom: '1px solid var(--oct-color-border)', fontFamily: M, fontSize: 14,
              color: 'var(--oct-color-text)', background: mine ? 'var(--oct-color-surface)' : 'transparent',
            }}>
              <div style={{ color: r.rank <= 3 ? 'var(--oct-color-warning)' : 'var(--oct-color-muted)', fontWeight: r.rank <= 3 ? 700 : 400 }}>#{r.rank}</div>
              <div>{shortenAddress(r.wallet)}{mine && <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-primary)', marginLeft: 8 }}>you</span>}</div>
              <div style={{ textAlign: 'right' }}>{active.fmt(r)}</div>
              <div style={{ textAlign: 'right', color: r.streak > 0 ? 'var(--oct-color-primary)' : 'var(--oct-color-faint)' }}>{r.streak}d</div>
              <div style={{ textAlign: 'right', color: TIER_COLOR[r.tier] || 'var(--oct-color-muted)', textTransform: 'capitalize' }}>{r.tier}</div>
            </div>
          )
        })}
      </div>
    </Page>
  )
}
