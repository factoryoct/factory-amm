
import { tokenSymbol, poolTokens } from '../config/tokens'
import { fromBaseUnits } from './format'

const INDEXER = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

export interface LPRecord {
  type:      'add' | 'remove' | 'collect'
  hash:      string
  timestamp: number
  sym0:      string
  sym1:      string
  amt0:      string
  amt1:      string
}

interface IndexerLp {
  hash: string; ts: number; kind: string
  pool: string; tick_lower: number; tick_upper: number; amount: string | null
  token0: string; token1: string; amount0: string; amount1: string
}

const abs = (x: bigint) => (x < 0n ? -x : x)
const fmt = (raw: string) => fromBaseUnits(abs(BigInt(raw || '0')), 6)

async function pairOf(r: IndexerLp): Promise<[string, string]> {
  let t0 = r.token0, t1 = r.token1
  if (!t0 || !t1) {
    const pair = await poolTokens(r.pool)
    if (pair) { t0 = pair.t0; t1 = pair.t1 }
  }
  return [tokenSymbol(t0 || ''), tokenSymbol(t1 || '')]
}

async function toRecord(type: LPRecord['type'], r: IndexerLp): Promise<LPRecord> {
  const [sym0, sym1] = await pairOf(r)
  return {
    type,
    hash:      r.hash,
    timestamp: r.ts,
    sym0,
    sym1,
    amt0:      fmt(r.amount0),
    amt1:      fmt(r.amount1),
  }
}

export async function loadLPHistory(wallet: string): Promise<LPRecord[]> {
  if (!INDEXER || !wallet) return []
  try {
    const res = await fetch(`${INDEXER}/?wallet=${wallet}&hist=1`)
    if (!res.ok) return []
    const rows = await res.json() as IndexerLp[]

    const removalBurns = rows.filter(r => r.kind === 'burn' && BigInt(r.amount || '0') > 0n)
    const isRemovalClaim = (c: IndexerLp) => removalBurns.some(b =>
      b.pool === c.pool && b.tick_lower === c.tick_lower && b.tick_upper === c.tick_upper &&
      c.ts >= b.ts && c.ts <= b.ts + 120_000,
    )

    const pending: Promise<LPRecord>[] = []
    for (const r of rows) {
      if (r.kind === 'mint') {
        pending.push(toRecord('add', r))
      } else if (r.kind === 'burn') {
        if (BigInt(r.amount || '0') === 0n) continue
        pending.push(toRecord('remove', r))
      } else {
        if (isRemovalClaim(r)) continue
        pending.push(toRecord('collect', r))
      }
    }
    return await Promise.all(pending)
  } catch { return [] }
}

export async function loadCollectedFees(wallet: string): Promise<Record<string, number>> {
  if (!INDEXER || !wallet) return {}
  try {
    const res = await fetch(`${INDEXER}/?wallet=${wallet}&fees=1`)
    if (res.ok) {
      const totals = await res.json() as unknown
      if (totals && typeof totals === 'object' && !Array.isArray(totals)) {
        const acc: Record<string, number> = {}
        for (const [tok, micro] of Object.entries(totals as Record<string, string>)) {
          const sym = tokenSymbol(tok)
          acc[sym] = (acc[sym] ?? 0) + Number(abs(BigInt(micro || '0'))) / 1e6
        }
        return acc
      }
    }
  } catch {  }
  try {
    const res = await fetch(`${INDEXER}/?wallet=${wallet}&hist=1`)
    if (!res.ok) return {}
    const pid = (r: IndexerLp) => `${r.pool}-${r.tick_lower}-${r.tick_upper}`
    const ord = (r: IndexerLp) => (r.kind === 'burn' ? 0 : r.kind === 'collect' ? 1 : 2)
    const rows = (await res.json() as IndexerLp[]).slice().sort((a, b) => (a.ts - b.ts) || (ord(a) - ord(b)))
    const lastBurn = new Map<string, bigint>()
    const acc: Record<string, number> = {}
    for (const r of rows) {
      if (r.kind === 'burn') { lastBurn.set(pid(r), BigInt(r.amount || '0')); continue }
      if (r.kind !== 'collect' || lastBurn.get(pid(r)) !== 0n) continue
      const [s0, s1] = await pairOf(r)
      acc[s0] = (acc[s0] ?? 0) + Number(abs(BigInt(r.amount0 || '0'))) / 1e6
      acc[s1] = (acc[s1] ?? 0) + Number(abs(BigInt(r.amount1 || '0'))) / 1e6
    }
    return acc
  } catch { return {} }
}

export async function saveLPHistory(_wallet: string, _rec: LPRecord): Promise<void> {
  if (INDEXER) {
    const q = _wallet ? `?wallet=${encodeURIComponent(_wallet)}` : ''
    try { await fetch(`${INDEXER}/sync${q}`) } catch {}
  }
  window.dispatchEvent(new CustomEvent('oct_history_updated'))
}
