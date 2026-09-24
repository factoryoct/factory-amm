import { getAllPools, bestPoolForPair, poolTokenUsd, type PoolMeta } from './pools'

export async function getTokenPriceUsd(factory: string, woct: string, token: string, octUsd: number, router = ''): Promise<number> {
  if (octUsd <= 0 || !factory || !token) return 0
  if (token === woct) return octUsd
  const pools = await getAllPools(factory)
  const best  = bestPoolForPair(pools, token, woct, router)
  return best ? poolTokenUsd(best, woct, octUsd) : 0
}

let priceMapValue: Record<string, number> | null = null
let priceMapAt = 0
let priceMapInflight: Promise<Record<string, number>> | null = null

export async function getTokenPricesUsd(factory: string, woct: string, octUsd: number, router = ''): Promise<Record<string, number>> {
  if (priceMapValue && Date.now() - priceMapAt < 30_000) return priceMapValue
  if (priceMapInflight) return priceMapInflight
  priceMapInflight = computePrices(factory, woct, octUsd, router)
    .then(val => { priceMapValue = val; priceMapAt = Date.now(); return val })
    .finally(() => { priceMapInflight = null })
  return priceMapInflight
}

async function computePrices(factory: string, woct: string, octUsd: number, router = ''): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (octUsd <= 0 || !factory) return out
  const pools = await getAllPools(factory)

  const tokens = new Set<string>()
  for (const p of pools) {
    if (p.token0 === woct) tokens.add(p.token1)
    else if (p.token1 === woct) tokens.add(p.token0)
  }
  for (const tok of tokens) {
    const best = bestPoolForPair(pools, tok, woct, router)
    if (!best) continue
    const usd = poolTokenUsd(best, woct, octUsd)
    if (usd > 0) out[tok] = usd
  }

  const bases = new Map<string, { p: PoolMeta; base: string }>()
  for (const p of pools) {
    if (p.liquidity <= 0) continue
    if (router && p.router && p.router !== router) continue
    if (p.token0 === woct || p.token1 === woct) continue
    for (const [token, base] of [[p.token0, p.token1], [p.token1, p.token0]] as [string, string][]) {
      if (out[base] === undefined || out[token] !== undefined) continue
      const had = bases.get(token)
      if (!had || p.liquidity > had.p.liquidity) bases.set(token, { p, base })
    }
  }
  for (const [token, { p, base }] of bases) {
    const usd = poolTokenUsd(p, base, out[base] ?? 0)
    if (usd > 0) out[token] = usd
  }
  return out
}
