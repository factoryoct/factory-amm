
import { tokenSymbol, poolTokens } from '../config/tokens'
import { fromBaseUnits } from './format'

const INDEXER = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

export interface SwapRecord {
  hash:      string
  timestamp: number
  tokenIn:   string
  tokenOut:  string
  amtIn:     string
  amtOut:    string
  route:     '1hop' | '2hop'
  tokenMid?: string
}

interface IndexerSwap {
  hash: string; pool: string; ts: number; token0: string; token1: string; amount0: string; amount1: string
}

const abs = (x: bigint) => (x < 0n ? -x : x)
const fmt = (raw: bigint) => fromBaseUnits(abs(raw), 6)

interface Leg { hash: string; ts: number; inAddr: string; outAddr: string; inRaw: bigint; outRaw: bigint }

const MULTIHOP_WINDOW = 120_000

export async function loadSwapHistory(wallet: string): Promise<SwapRecord[]> {
  if (!INDEXER || !wallet) return []
  try {
    const res = await fetch(`${INDEXER}/?wallet=${wallet}&swap=1`)
    if (!res.ok) return []
    const rows = await res.json() as IndexerSwap[]

    const legs: Leg[] = await Promise.all(rows.map(async r => {
      const a0 = BigInt(r.amount0 || '0')
      const a1 = BigInt(r.amount1 || '0')
      const zeroForOne = a0 > 0n
      let t0 = r.token0, t1 = r.token1
      if (!t0 || !t1) {
        const pair = await poolTokens(r.pool)
        if (pair) { t0 = pair.t0; t1 = pair.t1 }
      }
      return {
        hash: r.hash, ts: r.ts,
        inAddr:  zeroForOne ? t0 : t1,
        outAddr: zeroForOne ? t1 : t0,
        inRaw:   abs(zeroForOne ? a0 : a1),
        outRaw:  abs(zeroForOne ? a1 : a0),
      }
    }))

    const rec = (hash: string, ts: number, inA: string, inRaw: bigint, outA: string, outRaw: bigint, mid?: string): SwapRecord => ({
      hash, timestamp: ts,
      tokenIn: tokenSymbol(inA || ''), tokenOut: tokenSymbol(outA || ''),
      amtIn: fmt(inRaw), amtOut: fmt(outRaw),
      route: mid ? '2hop' : '1hop', tokenMid: mid ? tokenSymbol(mid) : undefined,
    })

    const used = new Set<number>()
    const out: SwapRecord[] = []
    for (let i = 0; i < legs.length; i++) {
      if (used.has(i)) continue
      const a = legs[i]
      let stitched: SwapRecord | null = null
      for (let j = 0; j < legs.length && !stitched; j++) {
        if (j === i || used.has(j)) continue
        const b = legs[j]
        if (Math.abs(a.ts - b.ts) > MULTIHOP_WINDOW) continue
        if (a.outAddr === b.inAddr && a.outRaw === b.inRaw) {
          used.add(i); used.add(j)
          stitched = rec(b.hash, Math.max(a.ts, b.ts), a.inAddr, a.inRaw, b.outAddr, b.outRaw, a.outAddr)
        } else if (b.outAddr === a.inAddr && b.outRaw === a.inRaw) {
          used.add(i); used.add(j)
          stitched = rec(a.hash, Math.max(a.ts, b.ts), b.inAddr, b.inRaw, a.outAddr, a.outRaw, a.inAddr)
        }
      }
      if (stitched) { out.push(stitched); continue }
      used.add(i)
      out.push(rec(a.hash, a.ts, a.inAddr, a.inRaw, a.outAddr, a.outRaw))
    }
    out.sort((x, y) => y.timestamp - x.timestamp)
    return out
  } catch { return [] }
}

export async function saveSwapHistory(_wallet: string, _rec: SwapRecord): Promise<void> {
  if (INDEXER) {
    const q = _wallet ? `?wallet=${encodeURIComponent(_wallet)}` : ''
    try { await fetch(`${INDEXER}/sync${q}`) } catch {}
  }
  window.dispatchEvent(new Event('oct_history_updated'))
}
