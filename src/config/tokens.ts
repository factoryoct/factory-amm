
import { CONTRACTS } from '../context/WalletContext'
import { contractCallView } from '../utils/rpc'
import { getAllPools } from '../utils/pools'

export interface TokenInfo {
  address:  string
  symbol:   string
  name:     string
  decimals: number
  native?:  boolean
  usd?:     number
  verified?: boolean
}

export function curatedTokens(): TokenInfo[] {
  return [
    { address: CONTRACTS.woct, symbol: 'OCT',  name: 'Octra',         decimals: 6, native: true, verified: true },
    { address: CONTRACTS.fact, symbol: 'FACT', name: 'Factory Token', decimals: 6, verified: true },
  ]
}

export const HIDDEN_TOKENS = new Map<string, string>([
  ['octDrGKb4U6bzwfiEED7SiMtZMjGyWMFvi3F5epBvjHbdqF', 'TEST'],
  ['octEBet5UG939prhP4DhkcamJRY8MdyoMZjTHoHd3T9EFcj', 'TEST6'],
  ['oct5F1oTEvR5ni616opQfbcede1caSEHg1ZfbqzRCWq1TCF', 'DEMO'],
  ['oct5grVQsZUeyP1ejGkvyKhWjR7UzLxdzejryyn96XQLQAY', 'LNCH'],
  ['octHa2TwaLakvNuNH8JtX98FC4w1ugoyQrJu1511a5t2g9a', 'LNCH'],
  ['oct3Mw6KEg1pdFMJoSov9sxADfF8zwpHauX2WKjTSZdiCfs', 'LNCH'],
  ['octENYWexr8xDgNiajgFPbYCcwoi4ujKr41Uhrvkr35zFKT', 'LNCH'],
  ['oct9eJNUAVLXHGeiFpBxCu4VFXEyTqmrN7CtQNHGhM7JbTU', 'LNCH'],
  ['octmZ7dpCeNnGxkU7XZ9Jw1AnQz5gEYXADsG5C5c7YvJrP5', 'MONEY'],
  ['octEuZZ8pSS1BTDYXG15GGneQwZXN67dAkzqU3cvMY6DyiY', 'MONEY'],
  ['octFbEgCmru9GHybrahP4Y55bPMaYiYQSj7t7RJW95RUKfY', 'SMON'],
  ['oct2dipnQUiHfF3hJhf73e3VgTSr2ifkZbJCxtGthT49s5i', 'SMON'],
  ['octAYeKVthcn7CemELqgrPvpcnhSb6P6n2AoXvi2zQNxpXP', 'SMON'],
  ['oct42X5DbDUPEGPSx9uJFK1eSi6XrSUwYMA5ffkjs1aiaWh', 'THRD'],
  ['oct5eJjsPe7Lp4j6ASamy55PhsYfzJm7agqLf8KCNo5qNvU', 'RTA'],
  ['oct7GYXq3SmhcR2wreuwjvi4tvZadjTtUTrNxUdCPjzfbXs', 'RTB'],
  ['octEpLjRqs2ensPiLp24dQyEYcR88sgED2DW7tUJzjd1jqU', 'NTB'],
  ['octGDHpFbEPoTroeGHDvvkM6UeS4wLGpzrZ68jeWMFQSjTj', 'NTA'],
  ['oct14gBvgbFo5LW4uteAfsY1idN2pDkthk7hHfXSehMhd6J', 'NTB'],
  ['octHsumDhaG5g9E3HmiLwGNvCK5MdgH1XqdPuTTmgCmk7hU', 'NTA'],
  ['oct83dHS8GDfhsphU1YyMDrWdzg2ScwvfoKewNGp2xQMWqc', 'NTA'],
  ['octF1HaPBkMKzeyPYs1WbBfPopbd2vttAG6B3d9h3J19jDw', 'NTB'],
])

const DENY_TOKENS = new Set<string>(HIDDEN_TOKENS.keys())

const EXTRA_KEY = 'oct_extra_tokens'
function loadExtras(): TokenInfo[] {
  try { return JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]') as TokenInfo[] } catch { return [] }
}

const DISC_CACHE_KEY = 'oct_pool_tokens'
function loadDiscoveredCache(): TokenInfo[] {
  try { return (JSON.parse(localStorage.getItem(DISC_CACHE_KEY) || '[]') as TokenInfo[]).map(t => ({ ...t, verified: false })) } catch { return [] }
}
let discoveredTokens: TokenInfo[] = loadDiscoveredCache()

const TOKENS_EVENT = 'oct:tokens'
function notifyTokensChanged() {
  try { window.dispatchEvent(new Event(TOKENS_EVENT)) } catch {  }
}
export function onTokensChanged(cb: () => void): () => void {
  window.addEventListener(TOKENS_EVENT, cb)
  return () => window.removeEventListener(TOKENS_EVENT, cb)
}

export function addLocalToken(t: TokenInfo) {
  const extras = loadExtras().filter(x => x.address !== t.address)
  extras.push(t)
  localStorage.setItem(EXTRA_KEY, JSON.stringify(extras))
  notifyTokensChanged()
  ensureCompatProbed()
}

const COMPAT_KEY = 'oct_token_compat'
function loadCompat(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COMPAT_KEY) || '{}') as Record<string, boolean> } catch { return {} }
}
let compatCache = loadCompat()
let compatProbing = false

export async function ensureCompatProbed(): Promise<void> {
  if (compatProbing) return
  const curated = new Set(curatedTokens().map(t => t.address))
  const todo = [...discoveredTokens, ...loadExtras()]
    .filter(t => !curated.has(t.address) && !(t.address in compatCache))
  if (todo.length === 0) return
  compatProbing = true
  try {
    await Promise.all(todo.map(async t => {
      try {
        const s = await contractCallView(t.address, 'get_symbol', [])
        compatCache[t.address] = !!String(s ?? '').trim()
      } catch { compatCache[t.address] = false }
    }))
    localStorage.setItem(COMPAT_KEY, JSON.stringify(compatCache))
  } finally { compatProbing = false }
  notifyTokensChanged()
}

let discovering = false
export async function refreshTokensFromPools(): Promise<void> {
  if (discovering) return
  discovering = true
  try {
    const pools = await getAllPools(CONTRACTS.factory).catch(() => [])
    const curated = new Set(curatedTokens().map(t => t.address))
    const addrs = new Set<string>()
    for (const p of pools) { addrs.add(p.token0); addrs.add(p.token1) }
    const todo = [...addrs].filter(a => a && !curated.has(a) && !DENY_TOKENS.has(a))
    if (todo.length === 0) return
    const known = new Map(discoveredTokens.map(t => [t.address, t]))
    const view = async (addr: string, m: string): Promise<unknown> => {
      try { return await contractCallView(addr, m, []) } catch { return undefined }
    }
    const probed = await Promise.all(todo.map(async addr => {
      const cached = known.get(addr)
      if (cached) return cached
      const sym = String((await view(addr, 'get_symbol')) ?? '').trim()
      if (!sym) return null
      const nm  = String((await view(addr, 'get_name')) ?? '').trim()
      const dec = Number(await view(addr, 'decimals'))
      return {
        address: addr, symbol: sym.slice(0, 10), name: nm || sym.slice(0, 10),
        decimals: (Number.isFinite(dec) && dec >= 0 && dec <= 18) ? dec : 6,
        verified: false,
      } as TokenInfo
    }))
    discoveredTokens = probed.filter((t): t is TokenInfo => !!t)
    localStorage.setItem(DISC_CACHE_KEY, JSON.stringify(discoveredTokens))
    notifyTokensChanged()
    ensureCompatProbed()
  } catch {  } finally { discovering = false }
}

export async function probeToken(address: string, symbolHint = '', decimalsHint?: number): Promise<TokenInfo> {
  const addr = address.trim()
  if (!/^oct[0-9A-Za-z]{20,}$/.test(addr)) throw new Error('not a valid Octra contract address')
  const existing = getToken(addr)
  if (existing) return existing
  try {
    await contractCallView(addr, 'balance_of', [addr])
  } catch {
    throw new Error('contract has no balance_of — not a token contract')
  }
  const tryView = async (m: string): Promise<unknown> => {
    try { return await contractCallView(addr, m, []) } catch { return undefined }
  }
  const onSym = String((await tryView('get_symbol')) ?? '').trim()
  const onName = String((await tryView('get_name')) ?? '').trim()
  const onDec  = Number(await tryView('decimals'))
  const symbol = (onSym || symbolHint.trim().toUpperCase() || addr.slice(3, 9)).slice(0, 10)
  const decimals = (Number.isFinite(onDec) && onDec >= 0 && onDec <= 18) ? onDec : (decimalsHint ?? 6)
  return { address: addr, symbol, name: onName || symbol, decimals, verified: false }
}

export function commitToken(t: TokenInfo): void {
  if (!getToken(t.address) || getToken(t.address)?.verified === false) addLocalToken(t)
}

export function listTokens(): TokenInfo[] {
  const out = new Map<string, TokenInfo>()
  for (const t of curatedTokens()) out.set(t.address, t)
  const curatedSymbols = new Set(curatedTokens().map(t => t.symbol))
  const add = (t: TokenInfo) => {
    if (out.has(t.address)) return
    if (DENY_TOKENS.has(t.address)) return
    if (curatedSymbols.has(t.symbol)) return
    if (compatCache[t.address] === false) return
    out.set(t.address, t)
  }
  for (const t of discoveredTokens) add(t)
  for (const t of loadExtras())     add(t)
  return [...out.values()]
}

export function duplicateSymbols(): Set<string> {
  const bySymbol = new Map<string, string[]>()
  for (const t of listTokens()) {
    const sym = t.symbol.toUpperCase()
    bySymbol.set(sym, [...(bySymbol.get(sym) ?? []), t.address])
  }
  const out = new Set<string>()
  for (const [, addrs] of bySymbol) if (addrs.length > 1) for (const one of addrs) out.add(one)
  return out
}

export function getToken(address: string): TokenInfo | undefined {
  return listTokens().find(t => t.address === address)
}

export function isKnownToken(address: string): boolean {
  return !!getToken(address)
}

export function tokenSymbol(address: string): string {
  return getToken(address)?.symbol ?? HIDDEN_TOKENS.get(address)
    ?? (address.slice(0, 6) + '…' + address.slice(-4))
}

export function tokenUsd(address: string, octUsd: number): number | undefined {
  const t = getToken(address)
  if (!t) return undefined
  if (t.native) return octUsd > 0 ? octUsd : undefined
  return t.usd
}

export async function poolTokens(pool: string): Promise<{ t0: string; t1: string } | null> {
  if (!pool) return null
  try {
    const { getAllPools } = await import('../utils/pools')
    const { CONTRACTS } = await import('../context/WalletContext')
    const p = (await getAllPools(CONTRACTS.factory)).find(x => x.address === pool)
    return p ? { t0: p.token0, t1: p.token1 } : null
  } catch { return null }
}
