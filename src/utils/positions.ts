
import { rpc } from './rpc'

export interface SavedPos {
  pool:       string
  owner:      string
  tickLower:  number
  tickUpper:  number
  addedAt:    number
  baseOwed0:  string
  baseOwed1:  string
}

const KEY    = (w: string) => `oct_lp_known_v1_${w}`
const SCAN_LIMIT_FIRST = 1200
const PAGE = 50

interface Store {
  seen: string[]
  lastHash: string
}

const empty: Store = { seen: [], lastHash: '' }

function read(w: string): Store {
  if (!w) return { ...empty }
  try {
    const raw = localStorage.getItem(KEY(w))
    if (!raw) return { ...empty }
    const v = JSON.parse(raw) as Partial<Store>
    return {
      seen:     Array.isArray(v.seen) ? v.seen : [],
      lastHash: typeof v.lastHash === 'string' ? v.lastHash : '',
    }
  } catch { return { ...empty } }
}

function write(w: string, s: Store) {
  if (!w) return
  try { localStorage.setItem(KEY(w), JSON.stringify(s)) } catch {  }
}

const sign = (pool: string, tl: number, tu: number) => `${pool}|${tl}|${tu}`

function toPos(sig: string, owner: string): SavedPos | null {
  const [pool, tl, tu] = sig.split('|')
  if (!pool || tl === undefined || tu === undefined) return null
  return {
    pool, owner,
    tickLower: Number(tl), tickUpper: Number(tu),
    addedAt: 0, baseOwed0: '0', baseOwed1: '0',
  }
}

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^oct[1-9A-HJ-NP-Za-km-z]{20,}$/.test(v)
const TICK_MAX = 887272
const isTick = (v: unknown): boolean => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN)
  return Number.isInteger(n) && Math.abs(n) <= TICK_MAX
}
const num    = (v: unknown): number => Number(v)
const okRange = (a: unknown, b: unknown) => isTick(a) && isTick(b) && num(a) < num(b)

interface Call { to?: string; method?: string; params?: unknown[] }

function fromCall(c: Call, out: Set<string>) {
  const p = c.params
  if (!Array.isArray(p)) return
  const m = c.method
  if (m === 'add_liquidity' && isAddr(p[0]) && okRange(p[2], p[3])) {
    out.add(sign(p[0], num(p[2]), num(p[3])))
    return
  }
  if (!c.to) return
  if (m === 'mint' && isAddr(p[0]) && okRange(p[1], p[2])) out.add(sign(c.to, num(p[1]), num(p[2])))
  if (m === 'burn' && okRange(p[0], p[1])) out.add(sign(c.to, num(p[0]), num(p[1])))
}

function fromBareParams(to: string, p: unknown[], out: Set<string>) {
  if (p.length === 7 && isAddr(p[0]) && isAddr(p[1]) && okRange(p[2], p[3])) {
    out.add(sign(p[0], num(p[2]), num(p[3])))
    return
  }
  if (!to) return
  if (p.length === 4 && isAddr(p[0]) && okRange(p[1], p[2])) out.add(sign(to, num(p[1]), num(p[2])))
  else if (p.length === 3 && okRange(p[0], p[1])) out.add(sign(to, num(p[0]), num(p[1])))
}

function parseMessage(to: string, message: string, out: Set<string>) {
  let body: unknown
  try { body = JSON.parse(message) } catch { return }
  if (Array.isArray(body)) { fromBareParams(to, body, out); return }
  const calls = (body as { calls?: unknown }).calls
  if (Array.isArray(calls)) for (const c of calls) fromCall(c as Call, out)
}

interface TxRow { hash: string; to?: string; op_type?: string; has_message?: boolean }

async function scan(wallet: string, store: Store): Promise<Store> {
  const found = new Set(store.seen)

  const first = await rpc<{ transactions?: TxRow[]; total?: number }>(
    'octra_transactionsByAddress', [wallet, PAGE, 0])
  const rows: TxRow[] = [...(first?.transactions ?? [])]
  const total = Math.min(first?.total ?? rows.length, SCAN_LIMIT_FIRST)

  const onFirst = store.lastHash && rows.some(r => r.hash === store.lastHash)
  if (!onFirst && total > PAGE) {
    const offsets: number[] = []
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o)
    const pages = await Promise.all(offsets.map(o =>
      rpc<{ transactions?: TxRow[] }>('octra_transactionsByAddress', [wallet, PAGE, o])
        .catch(() => ({ transactions: [] as TxRow[] }))))
    for (const pg of pages) rows.push(...(pg?.transactions ?? []))
  }

  const newestHash = rows[0]?.hash ?? store.lastHash
  const mark = store.lastHash ? rows.findIndex(r => r.hash === store.lastHash) : -1
  const fresh = mark >= 0 ? rows.slice(0, mark) : rows

  const want = fresh.filter(r => r.has_message !== false &&
    (r.op_type === 'multi_exec' || r.op_type === 'call'))

  const STEP = 400
  for (let i = 0; i < want.length; i += STEP) {
    const part = want.slice(i, i + STEP)
    const bodies = await Promise.all(part.map(r =>
      rpc<{ to?: string; message?: string } | null>('octra_transaction', [r.hash]).catch(() => null)))
    bodies.forEach((b, j) => {
      if (b?.message) parseMessage(b.to ?? part[j].to ?? '', b.message, found)
    })
  }

  return { seen: [...found], lastHash: newestHash }
}

let _inflight = new Map<string, Promise<SavedPos[]>>()

export async function fetchPositions(wallet: string): Promise<SavedPos[]> {
  if (!wallet) return []
  const running = _inflight.get(wallet)
  if (running) return running

  const store = read(wallet)
  const task = (async () => {
    let next = store
    try { next = await scan(wallet, store) } catch {  }
    write(wallet, next)
    return next.seen
      .map(s => toPos(s, wallet))
      .filter((p): p is SavedPos => p !== null)
  })()

  _inflight.set(wallet, task)
  try { return await task } finally { _inflight.delete(wallet) }
}

export async function savePosition(pos: SavedPos): Promise<void> {
  const s = read(pos.owner)
  const sig = sign(pos.pool, pos.tickLower, pos.tickUpper)
  if (!s.seen.includes(sig)) s.seen.push(sig)
  write(pos.owner, s)
}

export async function deletePosition(wallet: string, pool: string, tickLower: number, tickUpper: number): Promise<void> {
  const s = read(wallet)
  const sig = sign(pool, tickLower, tickUpper)
  s.seen = s.seen.filter(x => x !== sig)
  write(wallet, s)
}
