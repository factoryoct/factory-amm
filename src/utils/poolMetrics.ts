
import { contractCallView, getOctPrice } from './rpc'
import { getTokenPricesUsd } from './price'
import { sqrtPriceToPrice } from './math'
import { CONTRACTS } from '../context/WalletContext'

const POOL_INDEXER_URL = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

export interface PoolMetrics { tvl: number; volume24h: number; fees24h: number; apr: number }

export async function fetchPoolPrices(addr: string): Promise<{ epoch: number; price: number }[]> {
  if (!POOL_INDEXER_URL || !addr) return []
  try {
    const res = await fetch(`${POOL_INDEXER_URL}/?pool=${addr}&priceseries=1`)
    if (!res.ok) return []
    const rows = await res.json() as { ts: number; sqrtPrice: string }[]
    if (!Array.isArray(rows)) return []
    return rows
      .map(r => {
        let price = 0
        try { price = sqrtPriceToPrice(BigInt(r.sqrtPrice), 6, 6) } catch {  }
        return { epoch: Number(r.ts), price }
      })
      .filter(x => x.price > 0 && Number.isFinite(x.epoch))
  } catch { return [] }
}

function poolPriceKey(addr: string) { return 'oct_poolpx_' + addr }
export function loadPoolPrices(addr: string): { epoch: number; price: number }[] {
  try { return JSON.parse(localStorage.getItem(poolPriceKey(addr)) || '[]') } catch { return [] }
}
export function recordPoolPrice(addr: string, price: number): { epoch: number; price: number }[] {
  const arr = loadPoolPrices(addr)
  if (!(price > 0)) return arr
  const now = Date.now()
  if (arr.length && now - arr[arr.length - 1].epoch < 60_000) arr[arr.length - 1] = { epoch: now, price }
  else arr.push({ epoch: now, price })
  const trimmed = arr.slice(-300)
  try { localStorage.setItem(poolPriceKey(addr), JSON.stringify(trimmed)) } catch {  }
  return trimmed
}

export async function getPoolMetrics(addr: string, t0: string, t1: string, sqrtPrice: string, fee = 0): Promise<PoolMetrics> {
  let tvl = 0, volume24h = 0, fees24h = 0, apr = 0
  try {
    const octPrice  = await getOctPrice()
    const poolPrice = sqrtPriceToPrice(BigInt(sqrtPrice), 6, 6)
    const b0 = await contractCallView<string>(t0, 'balance_of', [addr])
    const b1 = await contractCallView<string>(t1, 'balance_of', [addr])
    if (octPrice > 0 && poolPrice > 0) {
      const prices = await getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, octPrice, CONTRACTS.router)
      const price = (t: string) => (t === CONTRACTS.woct ? octPrice : (prices[t] ?? 0))
      const p0 = price(t0)
      const p1 = price(t1)
      tvl = (Number(b0) / 1e6) * p0 + (Number(b1) / 1e6) * p1
      if (POOL_INDEXER_URL) {
        try {
          const res = await fetch(`${POOL_INDEXER_URL}?pool=${addr}`)
          if (res.ok) {
            const m = await res.json() as { vol0: string; vol1: string; fees0: string; fees1: string }
            const v0 = Number(m.vol0) / 1e6, v1 = Number(m.vol1) / 1e6
            volume24h = v0 * p0 + v1 * p1
            fees24h   = volume24h * (fee / 1_000_000)
            const MIN_TVL_FOR_APR = 1
            if (tvl >= MIN_TVL_FOR_APR && fees24h > 0) {
              apr = Math.min((fees24h * 365 / tvl) * 100, 100_000)
            }
          }
        } catch {  }
      }
    }
  } catch {  }
  return { tvl, volume24h, fees24h, apr }
}
