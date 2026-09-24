import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, YAxis, XAxis } from 'recharts'
import { type PoolMeta } from '../utils/pools'
import { getPoolMetrics, type PoolMetrics } from '../utils/poolMetrics'
import { contractCallTuple } from '../utils/rpc'
import { market, withoutSpikes } from '../utils/prices'
import { netState, type NetState } from '../utils/network'
import { tokenSymbol } from '../config/tokens'
import { feeToPercent, shortenAddress } from '../utils/format'
import { CONTRACTS } from '../context/WalletContext'
import { estimate, windowByHours, deviationPercent, type Estimate } from '../utils/oracle'

const INDEXER = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''
const F = 'var(--oct-type-ui)'
const M = 'var(--oct-type-mono)'

const RANGES = [
  { key: '24h', name: '24h', ms: 86_400_000 },
  { key: '7d',  name: '7d',  ms: 7 * 86_400_000 },
  { key: '30d', name: '30d', ms: 30 * 86_400_000 },
] as const
type Key = typeof RANGES[number]['key']

interface Point { ts: number; tvl: number; vol: number; fees: number }
interface Deal {
  type: 'swap' | 'mint' | 'burn' | 'collect'
  ts: number; pool: string; wallet: string
  amount0: string; amount1: string
}
interface PoolRow extends PoolMeta {
  metrics?: PoolMetrics
  memory?: number | null
  share?: [number, number]
}

const usd = (x: number) =>
  x >= 1_000_000 ? `$${(x / 1_000_000).toFixed(2)}M`
  : x >= 1000 ? `$${(x / 1000).toFixed(1)}k`
  : x >= 1 ? `$${x.toFixed(2)}`
  : x > 0 ? `$${x.toFixed(4)}` : '—'

const num = (x: number) => x.toLocaleString('en-US')

const axisUsd = (x: number) =>
  x >= 1_000_000 ? `$${(x / 1_000_000).toFixed(1)}M`
  : x >= 1000 ? `$${(x / 1000).toFixed(1)}k`
  : x >= 10 ? `$${Math.round(x)}`
  : x > 0 ? `$${x.toFixed(2)}` : '0'

const inWindowAt = (window: number) => (ts: number) => window <= 86_400_000
  ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  : new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

function Card({ children, title, right }: {
  children: React.ReactNode; title?: string; right?: React.ReactNode
}) {
  return (
    <section style={{
      background: 'var(--oct-color-bg)', borderRadius: 'var(--r-md)',
      boxShadow: '0 0 0 1px var(--oct-color-border)', padding: '16px 18px', minWidth: 0,
    }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <span style={{ fontFamily: F, fontSize: 14, fontWeight: 600, color: 'var(--oct-color-text)' }}>{title}</span>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

function Stat({ label, value, quiet }: { label: string; value: string; quiet?: boolean }) {
  return (
    <Card>
      <div style={{
        fontFamily: M, fontSize: 24, lineHeight: '30px', whiteSpace: 'nowrap',
        color: quiet ? 'var(--oct-color-faint)' : 'var(--oct-color-text)',
      }}>{value}</div>
      <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 4 }}>{label}</div>
    </Card>
  )
}

function Dot({ on }: { on: boolean }) {
  const color = on ? 'var(--oct-color-success)' : 'var(--oct-color-error)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ position: 'relative', width: 7, height: 7 }}>
        <span style={{
          position: 'absolute', inset: 0, borderRadius: '50%', background: color,
        }} />
        {on && (
          <span style={{
            position: 'absolute', inset: 0, borderRadius: '50%', background: color,
            animation: 'oct-pulse 2s ease-out infinite',
          }} />
        )}
      </span>
      <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)' }}>
        {on ? 'live' : 'stalled'}
      </span>
    </span>
  )
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
      <span style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-text-2)' }}>{left}</span>
      <span style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)' }}>{right}</span>
    </div>
  )
}

function Tip({ active, payload, label, what, window }: {
  active?: boolean; payload?: { value: number }[]; label?: number; what: string; window: number
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--oct-color-bg)', borderRadius: 'var(--r-xs)',
      boxShadow: '0 0 0 1px var(--oct-color-border-strong)', padding: '7px 10px',
    }}>
      <div style={{ fontFamily: M, fontSize: 12.5, color: 'var(--oct-color-text)' }}>{usd(payload[0].value)}</div>
      <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-muted)', marginTop: 2 }}>
        {what}{label ? `, ${inWindowAt(window)(label)}` : ''}
      </div>
    </div>
  )
}

const tdStyle: React.CSSProperties = { padding: '9px 10px', fontFamily: M, fontSize: 12.5, whiteSpace: 'nowrap' }
const thStyle: React.CSSProperties = {
  padding: '0 10px 8px', fontFamily: F, fontSize: 11.5, fontWeight: 600,
  color: 'var(--oct-color-muted)', whiteSpace: 'nowrap', textAlign: 'left',
}
const axis = { fontFamily: M, fontSize: 10, fill: 'var(--oct-color-faint)' }

export default function Protocol() {
  const [pools, setPools] = useState<PoolRow[]>([])
  const [net, setNet] = useState<NetState | null>(null)
  const [series, setSeries] = useState<Point[]>([])
  const [feed, setFeed] = useState<Deal[]>([])
  const [prices, setPrices] = useState<Map<string, number>>(new Map())
  const [octUsd, setOctUsd] = useState(0)
  const [oracle, setOracle] = useState<Estimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<Key>('24h')

  const window = RANGES.find(it => it.key === range)!.ms

  useEffect(() => {
    let alive = true

    if (INDEXER) {
      fetch(`${INDEXER}/?series=1`).then(r => r.ok ? r.json() : null)
        .then(j => { if (alive && Array.isArray(j)) setSeries(j as Point[]) }).catch(() => {})
      fetch(`${INDEXER}/?feed=1&limit=200`).then(r => r.ok ? r.json() : null)
        .then(j => { if (alive && Array.isArray(j)) setFeed(j as Deal[]) }).catch(() => {})
    }

    void estimate(CONTRACTS.woct, CONTRACTS.fact, windowByHours(1))
      .then(it => { if (alive) setOracle(it) })
      .catch(() => {})

    market().then(async ({ octUsd, prices, pools: ours }) => {
      if (!alive) return
      setOctUsd(octUsd)
      setPrices(prices)
      setPools(ours)
      setLoading(false)

      const done = await Promise.all(ours.map(async p => {
        const [metrics, memory, share] = await Promise.all([
          getPoolMetrics(p.address, p.token0, p.token1, p.sqrtPrice, p.fee).catch(() => undefined),
          contractCallTuple(p.address, 'obs_info', [])
            .then(arr => { const n = Number(arr[0]); return Number.isFinite(n) ? n : null })
            .catch(() => null),
          contractCallTuple(p.address, 'get_protocol_fees', [])
            .then(arr => [Number(arr[0]) || 0, Number(arr[1]) || 0] as [number, number])
            .catch(() => undefined),
        ])
        return { ...p, metrics, memory, share }
      }))
      if (alive) setPools(done)
    }).catch(() => { if (alive) setLoading(false) })

    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    const poll = () => { void netState().then(st => { if (alive) setNet(st) }) }
    poll()
    const id = setInterval(poll, 8000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const byAddress = useMemo(() => new Map(pools.map(p => [p.address, p])), [pools])

  const period = useMemo(() => {
    const edge = Date.now() - window
    const recent = feed.filter(deal => deal.ts >= edge)
    let volume = 0, fees = 0
    for (const deal of recent) {
      if (deal.type !== 'swap') continue
      const p = byAddress.get(deal.pool)
      if (!p) continue
      const a0 = Number(deal.amount0), a1 = Number(deal.amount1)
      const [token, amount] = a0 > 0 ? [p.token0, a0] : [p.token1, a1]
      const price = prices.get(token)
      if (!price || !(amount > 0)) continue
      const usd = (amount / 1e6) * price
      volume += usd
      fees += usd * (p.fee / 1_000_000)
    }
    return { volume, fees, deals: recent.length, had: feed.length > 0 }
  }, [feed, byAddress, prices, window])

  const income = useMemo(() => {
    let sum = 0, known = false
    for (const p of pools) {
      if (!p.share) continue
      const px0 = prices.get(p.token0), px1 = prices.get(p.token1)
      if (px0) { sum += (p.share[0] / 1e6) * px0; known = true }
      if (px1) { sum += (p.share[1] / 1e6) * px1; known = true }
    }
    return { sum, known }
  }, [pools, prices])

  const depth = pools.reduce((s, p) => s + (p.metrics?.tvl ?? 0), 0)
  const loaded = pools.some(p => p.metrics)
  const withMemory = pools.filter(p => (p.memory ?? 0) > 0).length

  const inWindow = useMemo(() => {
    const edge = Date.now() - window
    return withoutSpikes(series.filter(timer => timer.ts >= edge && timer.tvl > 0), timer => timer.tvl)
  }, [series, window])

  const contracts = ([
    ['factory', CONTRACTS.factory],
    ['router', CONTRACTS.router],
    ['quoter', CONTRACTS.quoter],
    ['wrapped OCT', CONTRACTS.woct],
    ['token metadata', CONTRACTS.tokenMeta],
  ] as [string, string][]).filter(([, a]) => !!a)

  const empty = (height: number) => (
    <div style={{ height: height, display: 'flex', alignItems: 'center', fontFamily: F, fontSize: 13, color: 'var(--oct-color-faint)' }}>
      not enough history
    </div>
  )

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 20px 40px' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <h1 style={{ fontFamily: F, fontSize: 22, fontWeight: 600, color: 'var(--oct-color-text)', margin: 0 }}>
          protocol
        </h1>
        <div style={{
          display: 'inline-flex', gap: 2, padding: 3,
          background: 'var(--oct-color-surface)', borderRadius: 'var(--r-sm)',
        }}>
          {RANGES.map(it => {
            const selected = it.key === range
            return (
              <button
                key={it.key}
                onClick={() => setRange(it.key)}
                style={{
                  fontFamily: M, fontSize: 12.5, padding: '6px 14px', border: 'none', cursor: 'pointer',
                  borderRadius: 'calc(var(--r-sm) - 3px)',
                  background: selected ? 'var(--oct-color-active)' : 'transparent',
                  color: selected ? 'var(--oct-color-action-ink)' : 'var(--oct-color-text-2)',
                }}
              >{it.name}</button>
            )
          })}
        </div>
      </div>

      <div style={{
        display: 'grid', gap: 16, marginBottom: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
      }}>
        <Stat label="total value locked" value={loaded ? usd(depth) : '—'} quiet={!loaded} />
        <Stat label={`volume, ${range}`} value={period.had ? usd(period.volume) : '—'} quiet={!period.had} />
        <Stat label={`fees, ${range}`} value={period.had ? usd(period.fees) : '—'} quiet={!period.had} />
        <Stat label="protocol revenue, unclaimed"
          value={income.known ? usd(income.sum) : '—'} quiet={!income.known} />
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginBottom: 16 }}>
        <Card title="liquidity">
          {inWindow.length < 2 ? empty(150) : (
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={inWindow} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="oct-tvl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--oct-color-active)" stopOpacity={0.34} />
                      <stop offset="100%" stopColor="var(--oct-color-active)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="ts" tickFormatter={inWindowAt(window)} tick={axis} axisLine={false} tickLine={false} minTickGap={44} />
                  <YAxis width={58} tick={axis} axisLine={false} tickLine={false} tickFormatter={axisUsd} />
                  <Tooltip content={<Tip what="liquidity" window={window} />} cursor={{ stroke: 'var(--oct-color-border-strong)' }} />
                  <Area type="monotone" dataKey="tvl" stroke="var(--oct-color-active)" strokeWidth={1.6}
                        fill="url(#oct-tvl)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="volume">
          {inWindow.length < 2 ? empty(150) : (
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={inWindow} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <XAxis dataKey="ts" tickFormatter={inWindowAt(window)} tick={axis} axisLine={false} tickLine={false} minTickGap={44} />
                  <YAxis width={58} tick={axis} axisLine={false} tickLine={false} tickFormatter={axisUsd} />
                  <Tooltip content={<Tip what="volume" window={window} />} cursor={{ fill: 'var(--oct-color-surface-hot)' }} />
                  <Bar dataKey="vol" fill="var(--oct-color-active)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div style={{ display: 'grid', gap: 16, alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>

        <Card title="pools">
          {loading && pools.length === 0
            ? <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-faint)' }}>loading</div>
            : pools.length === 0
            ? <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-faint)' }}>no pools yet</div>
            : (
              <div style={{ overflowX: 'auto' }} className="no-bar">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>pair</th>
                      <th style={thStyle}>fee</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>tvl</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>24h volume</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>oracle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...pools].sort((a, b) => (b.metrics?.tvl ?? 0) - (a.metrics?.tvl ?? 0)).map(p => (
                      <tr key={p.address} style={{ borderTop: '1px solid var(--oct-color-border)' }}>
                        <td style={tdStyle}>
                          <Link to={`/pool/${p.address}`} style={{ color: 'var(--oct-color-text)', textDecoration: 'none', fontWeight: 600 }}>
                            {tokenSymbol(p.token0)} / {tokenSymbol(p.token1)}
                          </Link>
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--oct-color-muted)' }}>{feeToPercent(p.fee)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{p.metrics ? usd(p.metrics.tvl) : '…'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{p.metrics ? usd(p.metrics.volume24h) : '…'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: (p.memory ?? 0) > 0 ? 'var(--oct-color-success)' : 'var(--oct-color-faint)' }}>
                          {(p.memory ?? 0) > 0 ? `${num(p.memory!)} obs` : 'no'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>

          <Card title="network" right={net ? <Dot on={!net.stalled} /> : undefined}>
            <div style={{ display: 'grid', gap: 8 }}>
              <Row left="epoch" right={net ? num(net.epoch) : '—'} />
              <Row left="finalized"
                      right={net && net.finalized ? num(net.finalized) : '—'} />
              <Row left="epoch time"
                      right={!net ? '—'
                        : net.stalled ? 'no new epochs'
                        : net.secondsPerEpoch ? `${net.secondsPerEpoch.toFixed(1)}s`
                        : 'measuring…'} />
              <Row left="transactions" right={net ? num(net.txTotal) : '—'} />
              <Row left="node" right={net?.version || '—'} />
            </div>
          </Card>

          <Card title="oracle">
            <div style={{ display: 'grid', gap: 8 }}>
              <Row left="pools with price memory" right={pools.length ? `${withMemory} / ${pools.length}` : '—'} />
              <Row left="observations stored" right={num(pools.reduce((a, p) => a + (p.memory ?? 0), 0))} />
              <Row left="OCT / FACT"
                      right={oracle ? oracle.price.toFixed(4) : '—'} />
              <Row left="window spread"
                      right={oracle ? `${deviationPercent(oracle.spread).toFixed(2)}%` : '—'} />
              <Row left="OCT price" right={octUsd > 0 ? `$${octUsd.toFixed(4)}` : '—'} />
            </div>
          </Card>

          <Card title="contracts">
            <div style={{ display: 'grid', gap: 7 }}>
              {contracts.map(([name, addr]) => (
                <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ fontFamily: F, fontSize: 12.5, color: 'var(--oct-color-text-2)' }}>{name}</span>
                  <a
                    href={`https://devnet.octrascan.io/address.html?addr=${addr}`}
                    target="_blank" rel="noreferrer"
                    style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-primary)', textDecoration: 'none' }}
                  >{shortenAddress(addr)}</a>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
