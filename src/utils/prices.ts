import { getAllPools, type PoolMeta } from './pools'
import { getOctMarket } from './rpc'
import { sqrtPriceToPrice } from './math'
import { CONTRACTS } from '../context/WalletContext'
import { isKnownToken } from '../config/tokens'

export interface Market {
  octUsd: number
  octChange24h: number | null
  prices: Map<string, number>
  pools: PoolMeta[]
  best: Map<string, PoolMeta>
}

const EMPTY: Market = {
  octUsd: 0, octChange24h: null, prices: new Map(), pools: [], best: new Map(),
}

function byPool(p: PoolMeta, token: string, baseUsd: number): number {
  const price = sqrtPriceToPrice(BigInt(p.sqrtPrice), 6, 6)
  if (!(price > 0) || !(baseUsd > 0)) return 0
  return p.token0 === token ? baseUsd * price : baseUsd / price
}

export async function market(): Promise<Market> {
  const [mkt, list] = await Promise.all([
    getOctMarket().catch(() => ({ price: 0, change24h: null as number | null })),
    getAllPools(CONTRACTS.factory).catch(() => [] as PoolMeta[]),
  ])
  const octUsd = mkt.price

  const visible = new Set<string>()
  const pools = list
    .filter(p => p.liquidity > 0 && (!CONTRACTS.router || !p.router || p.router === CONTRACTS.router))
    .filter(p => isKnownToken(p.token0) && isKnownToken(p.token1))
    .filter(p => { if (visible.has(p.address)) return false; visible.add(p.address); return true })

  if (!(octUsd > 0)) return { ...EMPTY, pools }

  const prices = new Map<string, number>([[CONTRACTS.woct, octUsd]])

  const best = new Map<string, PoolMeta>()
  for (const p of pools) {
    if (p.token0 !== CONTRACTS.woct && p.token1 !== CONTRACTS.woct) continue
    const token = p.token0 === CONTRACTS.woct ? p.token1 : p.token0
    if (token === CONTRACTS.woct) continue
    const had = best.get(token)
    if (!had || p.liquidity > had.liquidity) best.set(token, p)
  }
  for (const [token, p] of best) {
    const usd = byPool(p, token, octUsd)
    if (usd > 0) prices.set(token, usd)
  }

  const deepest = new Map<string, { p: PoolMeta; base: string }>()
  for (const p of pools) {
    if (p.token0 === CONTRACTS.woct || p.token1 === CONTRACTS.woct) continue
    for (const [token, base] of [[p.token0, p.token1], [p.token1, p.token0]] as [string, string][]) {
      if (!prices.has(base) || prices.has(token)) continue
      const had = deepest.get(token)
      if (!had || p.liquidity > had.p.liquidity) deepest.set(token, { p, base })
    }
  }
  for (const [token, { p, base }] of deepest) {
    const usd = byPool(p, token, prices.get(base) ?? 0)
    if (usd > 0) prices.set(token, usd)
  }

  return { octUsd, octChange24h: mkt.change24h ?? null, prices, pools, best }
}

export function withoutSpikes<T>(series: T[], pick: (x: T) => number): T[] {
  if (series.length < 3) return series
  return series.filter((point, i) => {
    if (i === 0 || i === series.length - 1) return true
    const v = pick(point), prev = pick(series[i - 1]), next = pick(series[i + 1])
    return !(v * 2 < prev && v * 2 < next)
  })
}
