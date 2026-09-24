import { contractCallView, contractCallTuple, getCodeHash } from './rpc'
import { POOL_CODE_HASHES } from '../config/poolHashes'
import { sqrtPriceToPrice } from './math'

export interface PoolMeta {
  address:   string
  token0:    string
  token1:    string
  fee:       number
  liquidity: number
  sqrtPrice: string
  router:    string
}

const STORE_KEY = 'oct_pools_cache_v1'
const STORE_MS = 10 * 60 * 1000

function loadStored(): { factory: string; pools: PoolMeta[] } | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const { at, factory, pools } = JSON.parse(raw) as { at: number; factory?: string; pools: PoolMeta[] }
    if (!Array.isArray(pools) || !pools.length) return null
    if (Date.now() - at > STORE_MS) return null
    return { factory: String(factory ?? ''), pools: pools }
  } catch { return null }
}

function store(pools: PoolMeta[], factory: string) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), factory, pools })) } catch {  }
}

const _stored = loadStored()
let _cache: PoolMeta[] | null = _stored ? _stored.pools : null
let _cacheZavod = _stored ? _stored.factory : ''
let _cacheAt = _cache ? Date.now() - 29_000 : 0
let _inflight: Promise<PoolMeta[]> | null = null
const _lastGood = new Map<string, PoolMeta>()

export async function getAllPools(factory: string, force = false): Promise<PoolMeta[]> {
  if (_cache && _cacheZavod && _cacheZavod !== factory) {
    _cache = null; _cacheAt = 0; _lastGood.clear()
    try { localStorage.removeItem(STORE_KEY) } catch {  }
  }
  if (!force && _cache && Date.now() - _cacheAt < 30_000) return _cache
  if (!force && _inflight) return _inflight
  if (!factory) return []

  const run = async (): Promise<PoolMeta[]> => {
    const readMeta = async (addr: string): Promise<PoolMeta | null> => {
      try {
        if (!addr) return null
        const [tokens, cfg, slot0, liq, router, codeHash] = await Promise.all([
          contractCallTuple(addr, 'get_tokens', []),
          contractCallTuple(addr, 'get_config', []),
          contractCallTuple(addr, 'get_slot0', []),
          contractCallView<string>(addr, 'get_liquidity', []).catch(() => '0'),
          contractCallView<string>(addr, 'get_router', []).catch(() => ''),
          getCodeHash(addr).catch(() => ''),
        ])
        if (codeHash && !POOL_CODE_HASHES.has(codeHash)) return null
        const meta: PoolMeta = {
          address: addr, token0: tokens[0], token1: tokens[1],
          fee: Number(cfg[0]) || 0, liquidity: Number(liq) || 0,
          sqrtPrice: slot0[0] || '0', router: router || '',
        }
        _lastGood.set(addr, meta)
        return meta
      } catch {
        return (addr && _lastGood.get(addr)) || null
      }
    }

    const out: PoolMeta[] = []
    try {
      const known = (_cache ?? []).map(p => p.address).filter(Boolean)
      const knownP = Promise.all(known.map(readMeta))

      const listP = (async () => {
        const count = Number(await contractCallView<string>(factory, 'get_pool_count', []))
        const LIMIT = 150
        const start = Math.max(0, count - LIMIT)
        const idx = Array.from({ length: Math.min(count, LIMIT) }, (_, i) => start + i)
        return Promise.all(idx.map(i =>
          contractCallView<string>(factory, 'get_pool_at', [i]).catch(() => '')))
      })()

      const addrs = [...new Set((await listP).filter(Boolean))]
      const seen = new Set(known)
      const extra = addrs.filter(a => !seen.has(a))
      const [knownMetas, extraMetas] = await Promise.all([knownP, Promise.all(extra.map(readMeta))])

      const byAddr = new Map<string, PoolMeta>()
      for (const m of [...knownMetas, ...extraMetas]) if (m) byAddr.set(m.address, m)
      for (const a of addrs) { const m = byAddr.get(a); if (m) out.push(m) }

      if (out.length) { _cache = out; _cacheAt = Date.now(); _cacheZavod = factory; store(out, factory); _lastGood.clear(); for (const m of out) _lastGood.set(m.address, m) }
    } catch {  }
    return out
  }

  if (force) return run()
  _inflight = run().finally(() => { _inflight = null })
  return _inflight
}

function pairMatch(p: PoolMeta, a: string, b: string): boolean {
  return (p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a)
}

export function poolTokenUsd(p: PoolMeta, woct: string, octUsd: number): number {
  if (octUsd <= 0 || !p.sqrtPrice || p.sqrtPrice === '0') return 0
  const price = sqrtPriceToPrice(BigInt(p.sqrtPrice), 6, 6)
  if (!(price > 0) || price < 1e-15 || price > 1e15) return 0
  return p.token0 === woct ? octUsd / price : octUsd * price
}

export function bestPoolForPair(pools: PoolMeta[], a: string, b: string, router: string): PoolMeta | null {
  const valid = pools.filter(p =>
    p.liquidity > 0 &&
    (!router || !p.router || p.router === router) &&
    pairMatch(p, a, b))
  if (!valid.length) return null
  return valid.reduce((best, p) => (p.liquidity > best.liquidity ? p : best))
}

export async function routeMatches(
  factory: string,
  legs: { from: string; to: string; feeTier: number }[],
): Promise<{ ok: boolean; leg?: { from: string; to: string; feeTier: number }; foreign?: string }> {
  if (!factory) return { ok: true }
  let ours = new Set((await getAllPools(factory)).map(p => p.address))
  let reread = false
  for (const leg of legs) {
    let canonical = ''
    try {
      canonical = String(await contractCallView<string>(
        factory, 'get_canonical', [leg.from, leg.to, String(leg.feeTier)]) ?? '')
    } catch {
      continue
    }
    if (!canonical || ours.has(canonical)) continue
    if (!reread) {
      reread = true
      ours = new Set((await getAllPools(factory, true)).map(p => p.address))
      if (ours.has(canonical)) continue
    }
    return { ok: false, leg, foreign: canonical }
  }
  return { ok: true }
}
