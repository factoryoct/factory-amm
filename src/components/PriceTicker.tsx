import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchPoolPrices } from '../utils/poolMetrics'
import { market } from '../utils/prices'
import { tokenSymbol } from '../config/tokens'
import { CONTRACTS } from '../context/WalletContext'

const DAY_MS = 86_400_000
const NEAR_DAY_MS = 20 * 3600 * 1000

const ROW_HEIGHT = 34

export interface Row {
  symbol: string
  usd: number
  change: number | null
}

async function collect(): Promise<Row[]> {
  const { octUsd, octChange24h, prices, best } = await market()
  if (!(octUsd > 0)) return []

  const out: Row[] = [{ symbol: 'OCT', usd: octUsd, change: octChange24h }]

  for (const [token, usd] of prices) {
    if (token === CONTRACTS.woct) continue

    let change: number | null = null
    const p = best.get(token)
    if (p && octChange24h != null) {
      const series = await fetchPoolPrices(p.address).catch(() => [])
      if (series.length > 1) {
        const now = series[series.length - 1]
        const target = Date.now() - DAY_MS
        let base = series[0]
        for (const timer of series) if (Math.abs(timer.epoch - target) < Math.abs(base.epoch - target)) base = timer
        if (now.epoch - base.epoch >= NEAR_DAY_MS && base.price > 0) {
          const inPool = (now.price - base.price) / base.price
          const own = p.token0 === token ? inPool : -inPool / (1 + inPool)
          change = ((1 + own) * (1 + octChange24h / 100) - 1) * 100
        }
      }
    }
    const name = tokenSymbol(token)
    if (name.startsWith('oct') && name.includes('…')) continue
    out.push({ symbol: name, usd, change })
  }
  return out
}

const usd = (x: number) =>
  x >= 1 ? `$${x.toFixed(4)}` : `$${x.toFixed(Math.min(8, Math.max(4, Math.ceil(-Math.log10(x)) + 3)))}`

function Cell({ row }: { row: Row }) {
  const color = row.change == null ? 'var(--oct-color-faint)'
    : row.change > 0 ? 'var(--oct-color-success)'
    : row.change < 0 ? 'var(--oct-color-danger)'
    : 'var(--oct-color-faint)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, padding: '0 18px', whiteSpace: 'nowrap' }}>
      <span style={{ fontFamily: 'var(--oct-type-ui)', fontSize: 12, fontWeight: 600, color: 'var(--oct-color-text-2)' }}>
        {row.symbol}
      </span>
      <span style={{ fontFamily: 'var(--oct-type-mono)', fontSize: 12, color: 'var(--oct-color-text)' }}>
        {usd(row.usd)}
      </span>
      {row.change != null && (
        <span style={{ fontFamily: 'var(--oct-type-mono)', fontSize: 12, color: color }}>
          {`${row.change > 0 ? '+' : ''}${row.change.toFixed(2)}%`}
        </span>
      )}
    </span>
  )
}

export default function PriceTicker() {
  const [rows, setRows] = useState<Row[]>([])
  const [paused, setPaused] = useState(false)
  const [groupWidth, setGroupWidth] = useState(0)
  const [passWidth, setPassWidth] = useState(0)
  const [stripWidth, setStripWidth] = useState(0)
  const aliveRef = useRef(true)
  const strip  = useRef<HTMLDivElement | null>(null)
  const group   = useRef<HTMLSpanElement | null>(null)
  const pass  = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    aliveRef.current = true
    const tick = () => { collect().then(r => { if (aliveRef.current) setRows(r) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, 60_000)
    return () => { aliveRef.current = false; clearInterval(id) }
  }, [])

  useLayoutEffect(() => {
    const measure = () => {
      if (group.current)  setGroupWidth(group.current.getBoundingClientRect().width)
      if (pass.current) setPassWidth(pass.current.getBoundingClientRect().width)
      if (strip.current) setStripWidth(strip.current.getBoundingClientRect().width)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (group.current)  observer.observe(group.current)
    if (pass.current) observer.observe(pass.current)
    if (strip.current) observer.observe(strip.current)
    return () => observer.disconnect()
  }, [rows])

  const hasRows = rows.length > 0
  useEffect(() => {
    const root = document.documentElement
    const clear = () => { root.style.removeProperty('--oct-ticker-h') }
    if (hasRows) root.style.setProperty('--oct-ticker-h', ROW_HEIGHT + 'px')
    else clear()
    return clear
  }, [hasRows])

  if (!hasRows) return null

  const repeats = passWidth > 0 && stripWidth > 0
    ? Math.max(1, Math.ceil(stripWidth / passWidth) + 1)
    : 3

  const PX_PER_SECOND = 34
  const seconds = groupWidth > 0 ? groupWidth / PX_PER_SECOND : 30

  return (
    <div
      ref={strip}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      style={{
        flex: 'none', height: 34, overflow: 'hidden', position: 'relative',
        background: 'var(--oct-color-surface-soft)',
        borderTop: '1px solid var(--oct-color-border)',
        display: 'flex', alignItems: 'center',
      }}
    >
      <style>{`
        @keyframes oct-ticker { from { transform: translateX(0) } to { transform: translateX(calc(-1 * var(--oct-ticker-w))) } }
        @media (prefers-reduced-motion: reduce) { .oct-ticker-run { animation: none !important } }
      `}</style>
      <div
        className="oct-ticker-run"
        style={{
          display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
          willChange: 'transform',
          ['--oct-ticker-w' as string]: `${groupWidth}px`,
          animationName: groupWidth > 0 ? 'oct-ticker' : 'none',
          animationDuration: `${seconds}s`,
          animationTimingFunction: 'linear',
          animationIterationCount: 'infinite',
          animationPlayState: paused ? 'paused' : 'running',
        }}
      >
        {[0, 1].map(lap => (
          <span
            key={lap}
            ref={lap === 0 ? group : undefined}
            aria-hidden={lap === 1}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            {Array.from({ length: repeats }).map((_, ri) => (
              <span
                key={ri}
                ref={lap === 0 && ri === 0 ? pass : undefined}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                {rows.map(row => <Cell key={`${lap}-${ri}-${row.symbol}`} row={row} />)}
              </span>
            ))}
          </span>
        ))}
      </div>
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'linear-gradient(90deg, var(--oct-color-surface-soft), transparent 6%, transparent 94%, var(--oct-color-surface-soft))',
      }} />
    </div>
  )
}
