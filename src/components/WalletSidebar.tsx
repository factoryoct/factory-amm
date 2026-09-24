import { useEffect, useState } from 'react'
import Segmented from './Segmented'
import { useWallet, CONTRACTS } from '../context/WalletContext'
import { contractCallView, getOctPrice, lastOctPrice } from '../utils/rpc'
import { getTokenPriceUsd, getTokenPricesUsd } from '../utils/price'
import { loadLPHistory, type LPRecord } from '../utils/lpHistory'
import { loadSwapHistory, type SwapRecord } from '../utils/swapHistory'
import { HIDDEN_TOKENS, listTokens, onTokensChanged } from '../config/tokens'

type ActivityRecord =
  | ({ kind: 'swap' } & SwapRecord)
  | ({ kind: 'lp'   } & LPRecord)
const F = 'var(--oct-type-ui)'
const M = 'var(--oct-type-mono)'

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const day   = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const hh    = String(d.getHours()).padStart(2, '0')
  const mm    = String(d.getMinutes()).padStart(2, '0')
  return `${day}.${month} ${hh}:${mm}`
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function resolveSym(s: string): string {
  if (!s || !s.startsWith('oct') || !s.includes('…')) return s
  const pre = s.slice(0, 6), suf = s.slice(-4)
  const matches = (a: string) => a.slice(0, 6) === pre && a.slice(-4) === suf
  const t = listTokens().find(x => matches(x.address))
  if (t) return t.symbol
  for (const [addr, name] of HIDDEN_TOKENS) if (matches(addr)) return name
  return s
}

export default function WalletSidebar() {
  const { address, balance, connected, walletSidebarOpen, closeWalletSidebar, disconnect, refreshBalance } = useWallet()
  const [tab, setTab]           = useState<'tokens' | 'activity'>('tokens')
  const [octPrice, setOctPrice] = useState(lastOctPrice)
  const [factBal, setFactBal]   = useState('0')
  const [factPrice, setFactPrice] = useState(0)
  const [tokenBals, setTokenBals] = useState<Record<string, string>>({})
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({})
  const [activity, setActivity] = useState<ActivityRecord[]>([])
  const [, setRefreshing] = useState(false)
  const [spinning,   setSpinning]   = useState(false)

  async function buildActivity(addr: string): Promise<ActivityRecord[]> {
    const [swapRecs, lpRecs] = await Promise.all([loadSwapHistory(addr), loadLPHistory(addr)])
    const swaps: ActivityRecord[] = swapRecs.map(r => ({ kind: 'swap' as const, ...r }))
    const lp: ActivityRecord[]    = lpRecs.map(r => ({ kind: 'lp' as const, ...r }))
    return [...swaps, ...lp].sort((a, b) => b.timestamp - a.timestamp)
  }

  async function refresh() {
    if (!address || spinning) return
    setRefreshing(true)
    setSpinning(true)
    const minDelay = new Promise(res => setTimeout(res, 1200))
    try {
      const price = await getOctPrice().catch(() => octPrice)
      setOctPrice(price)
      await Promise.all([
        refreshBalance(),
        contractCallView<string>(CONTRACTS.fact, 'balance_of', [address]).then(setFactBal).catch(() => {}),
        getTokenPriceUsd(CONTRACTS.factory, CONTRACTS.woct, CONTRACTS.fact, price, CONTRACTS.router).then(setFactPrice).catch(() => {}),
        getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, price, CONTRACTS.router).then(setTokenPrices).catch(() => {}),
        (async () => {
          const bals: Record<string, string> = {}
          await Promise.all(listTokens().filter(t => !t.native).map(t =>
            contractCallView<string>(t.address, 'balance_of', [address])
              .then(b => { bals[t.address] = b }).catch(() => { bals[t.address] = '0' })))
          setTokenBals(bals)
        })(),
        buildActivity(address).then(setActivity),
        minDelay,
      ])
    } finally {
      setRefreshing(false)
      setSpinning(false)
    }
  }

  useEffect(() => {
    if (!walletSidebarOpen || !connected || !address) return
    refresh()
  }, [walletSidebarOpen, connected, address])

  useEffect(() => onTokensChanged(() => { if (walletSidebarOpen && connected && address) refresh() }), [walletSidebarOpen, connected, address])

  useEffect(() => {
    if (!address) return
    const reload = () => buildActivity(address).then(setActivity)
    window.addEventListener('oct_history_updated', reload)
    return () => window.removeEventListener('oct_history_updated', reload)
  }, [address])

  const octBal   = Number(balance) / 1e6
  const octUsd   = octBal * octPrice
  const priceFor = (t: { address: string }) => tokenPrices[t.address] ?? (t.address === CONTRACTS.fact ? factPrice : 0)
  const tokensUsd = listTokens().filter(t => !t.native).reduce((s, t) => {
    const bal = Number(tokenBals[t.address] ?? (t.address === CONTRACTS.fact ? factBal : '0')) / 1e6
    return s + bal * priceFor(t)
  }, 0)
  const totalUsd = octUsd + tokensUsd

  return (
    <div className="app-sidebar" style={{
      width: walletSidebarOpen ? 408 : 0,
      flexShrink: 0,
      overflow: 'hidden',
      transition: 'width .32s var(--ease)',
      display: 'flex',
      fontFamily: F,
    }}>
      <div style={{
        width: 392, flexShrink: 0, margin: '18px 16px 16px 0', height: 'calc(100% - 34px)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--oct-color-bg)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--sh-lg)',
        overflow: 'hidden',
      }}>

        <div style={{ padding: '16px 18px 2px', flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', marginBottom: 6 }}>total value</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontFamily: M, fontSize: 30, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--oct-color-text)' }}>
              {octPrice > 0 ? '$' + totalUsd.toFixed(2) : 'n/a'}
            </div>
            <button
              onClick={refresh}
              disabled={spinning}
              title="refresh"
              style={{
                background: 'none', border: 'none', cursor: spinning ? 'default' : 'pointer',
                color: spinning ? 'var(--oct-color-border)' : 'var(--oct-color-muted)', padding: 0,
                display: 'flex', alignItems: 'center',
                transition: 'color 0.15s',
              }}
            >
              <svg
                width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"
                style={{
                  transformOrigin: 'center',
                  willChange: 'transform',
                  animation: spinning ? 'oct-spin 0.8s linear infinite' : 'none',
                }}
              >
                <path d="M23 4v6h-6"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
            <button
              onClick={async () => { await disconnect(); closeWalletSidebar() }}
              style={{
                marginLeft: 'auto',
                background: 'var(--oct-color-surface)', border: 'none', cursor: 'pointer',
                color: 'var(--oct-color-muted)', padding: '7px 12px',
                borderRadius: 'var(--r-sm)', fontFamily: F, fontSize: 12,
              }}
            >disconnect</button>
          </div>
        </div>

        <div style={{ padding: '10px 18px 6px', flexShrink: 0 }}>
          <Segmented
            full
            height={30}
            value={tab}
            onChange={v => setTab(v)}
            items={[{ value: 'tokens' as const, label: 'tokens' }, { value: 'activity' as const, label: 'activity' }]}
          />
        </div>

        <div className="no-bar" style={{ flex: 1, overflowY: 'auto' }}>

          {tab === 'tokens' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, color: 'var(--oct-color-text)' }}>OCT</div>
                    <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 2 }}>{octBal.toFixed(4)}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)' }}>
                    {octPrice > 0 ? '$' + octUsd.toFixed(2) : 'n/a'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 2 }}>
                    {octPrice > 0 ? '$' + octPrice.toFixed(4) + ' / OCT' : ''}
                  </div>
                </div>
              </div>

              {listTokens().filter(t => !t.native).map(t => {
                const isFact = t.address === CONTRACTS.fact
                const bal    = Number(tokenBals[t.address] ?? (isFact ? factBal : '0')) / 1e6
                if (bal <= 0) return null
                const px  = priceFor(t)
                const usd = bal * px
                return (
                  <div key={t.address} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 14, color: 'var(--oct-color-text)' }}>{t.symbol}</div>
                        <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 2 }}>
                          {bal.toFixed(4)}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)' }}>{usd > 0 ? '$' + usd.toFixed(2) : ''}</div>
                      {px > 0 && <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 2 }}>${px < 0.01 ? px.toFixed(6) : px.toFixed(4)} / {t.symbol}</div>}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {tab === 'activity' && (
            activity.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center', fontSize: 13, color: 'var(--oct-color-muted)' }}>
                no activity yet
              </div>
            ) : (
              activity.map((rec, i) => {
                const hash = rec.kind === 'swap' ? rec.hash : rec.hash
                const ts   = rec.kind === 'swap' ? rec.timestamp : rec.timestamp
                let label = '', sub = ''
                if (rec.kind === 'swap') {
                  label = `${rec.amtIn} ${resolveSym(rec.tokenIn)} to ${rec.amtOut} ${resolveSym(rec.tokenOut)}`
                  if (rec.route === '2hop' && rec.tokenMid) sub = `via ${resolveSym(rec.tokenMid)}`
                } else {
                  const s0 = resolveSym(rec.sym0), s1 = resolveSym(rec.sym1)
                  const pair = `${s0}/${s1}`
                  label = rec.type === 'add' ? `liquidity added ${pair}` : rec.type === 'remove' ? `liquidity removed ${pair}` : `fees collected ${pair}`
                  const parts = []
                  if (rec.amt0 && rec.amt0 !== '0') parts.push(`${rec.amt0} ${s0}`)
                  if (rec.amt1 && rec.amt1 !== '0') parts.push(`${rec.amt1} ${s1}`)
                  sub = parts.join(' + ')
                }
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 18px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', wordBreak: 'break-word' }}>
                        {label}
                      </div>
                      {sub && <div style={{ fontSize: 11, color: 'var(--oct-color-muted)', marginTop: 2, wordBreak: 'break-word' }}>{sub}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 12 }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: 'var(--oct-color-muted)', fontFamily: M, whiteSpace: 'nowrap' }}>{fmtDateTime(ts)}</div>
                        <div style={{ fontSize: 10, color: 'var(--oct-color-faint)', fontFamily: M, whiteSpace: 'nowrap' }}>{timeAgo(ts)}</div>
                      </div>
                      <a
                        href={`https://devnet.octrascan.io/tx.html?hash=${hash}`}
                        target="_blank" rel="noopener noreferrer" title={hash}
                        style={{ fontSize: 11, color: 'var(--oct-color-muted)', textDecoration: 'none', fontFamily: M }}
                      >tx</a>
                    </div>
                  </div>
                )
              })
            )
          )}

        </div>
      </div>
    </div>
  )
}
