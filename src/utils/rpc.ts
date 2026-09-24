
import { getOctra } from './walletOctra'

const RPC_URL = '/rpc'

const PRICE_KEY = 'oct_price_v1'
let _octPriceCached = 0
let _octPriceFetchedAt = 0
let _octChange24h: number | null = null

try {
  const raw = localStorage.getItem(PRICE_KEY)
  if (raw) {
    const v = JSON.parse(raw) as { p: number; c: number | null }
    if (v && v.p > 0) { _octPriceCached = v.p; _octChange24h = v.c ?? null }
  }
} catch {  }

export function lastOctPrice(): number { return _octPriceCached }

function rememberPrice(price: number, change: number | null) {
  if (!(price > 0)) return
  _octPriceCached = price
  _octChange24h = change
  _octPriceFetchedAt = Date.now()
  try { localStorage.setItem(PRICE_KEY, JSON.stringify({ p: price, c: change })) } catch {  }
}

let _priceInflight: Promise<void> | null = null

async function readPrice(): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch('/price', { signal: controller.signal, headers: { accept: 'application/json' } })
    const json = await res.json() as { octra?: { usd?: number; usd_24h_change?: number } }
    const price = json?.octra?.usd ?? 0
    const change = typeof json?.octra?.usd_24h_change === 'number' ? json.octra.usd_24h_change : null
    rememberPrice(price, change)
  } finally {
    clearTimeout(timer)
  }
}

function refreshPrice(): Promise<void> {
  if (_priceInflight) return _priceInflight
  _priceInflight = readPrice().catch(() => {}).finally(() => { _priceInflight = null })
  return _priceInflight
}

export async function getOctPrice(): Promise<number> {
  if (_octPriceCached > 0 && Date.now() - _octPriceFetchedAt < 60_000) return _octPriceCached
  if (_octPriceCached > 0) { void refreshPrice(); return _octPriceCached }
  await refreshPrice()
  return _octPriceCached
}

export async function getOctMarket(): Promise<{ price: number; change24h: number | null }> {
  if (_octPriceCached > 0 && Date.now() - _octPriceFetchedAt < 60_000) {
    return { price: _octPriceCached, change24h: _octChange24h }
  }
  if (_octPriceCached > 0) { void refreshPrice(); return { price: _octPriceCached, change24h: _octChange24h } }
  await refreshPrice()
  return { price: _octPriceCached, change24h: _octChange24h }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const BATCH_WINDOW_MS = 12
const BATCH_MAX = 100
const CACHE_MS = 4000

type Waiting = { method: string; params: unknown[]; key: string; ok: (v: unknown) => void; no: (e: unknown) => void }

let queue: Waiting[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const fresh = new Map<string, { at: number; value: unknown }>()

const keyOf = (method: string, params: unknown[]) =>
  method + '|' + JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

async function post(payload: unknown): Promise<Response> {
  return fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  })
}

async function sendBatch(group: Waiting[]) {
  const byKey = new Map<string, Waiting[]>()
  for (const w of group) {
    const list = byKey.get(w.key)
    if (list) list.push(w)
    else byKey.set(w.key, [w])
  }

  let pending = [...byKey.entries()]
  let lastErr: unknown

  for (let attempt = 0; attempt < 10 && pending.length; attempt++) {
    if (attempt > 0) {
      await sleep(attempt === 1
        ? 40 + Math.random() * 60
        : Math.min(1500, 240 * attempt) + Math.random() * 200)
    }

    const payload = pending.map(([, list], i) => ({
      jsonrpc: '2.0', id: i, method: list[0].method, params: list[0].params,
    }))

    try {
      const res = await post(payload.length === 1 ? payload[0] : payload)
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`RPC HTTP ${res.status}`); continue }
      const raw = await res.json()
      const list: { id: number; result?: unknown; error?: { code: number; message: string } }[] =
        Array.isArray(raw) ? raw : [{ ...raw, id: 0 }]
      const byId = new Map(list.map(r => [r.id, r]))

      const again: typeof pending = []
      pending.forEach((entry, i) => {
        const [key, waiters] = entry
        const r = byId.get(i)
        if (!r) { again.push(entry); lastErr = new Error('RPC: no response to the request'); return }
        if (r.error && (r.error.code === -32005 || /busy|too many/i.test(String(r.error.message)))) {
          again.push(entry); lastErr = new Error('RPC busy'); return
        }
        if (r.error) {
          const e = new Error(`RPC error [${r.error.code}]: ${r.error.message}`)
          waiters.forEach(w => w.no(e))
          return
        }
        if (!NO_CACHE.has(waiters[0].method)) fresh.set(key, { at: Date.now(), value: r.result })
        waiters.forEach(w => w.ok(r.result))
      })
      pending = again
    } catch (e) {
      lastErr = e
    }
  }

  if (pending.length) {
    const err = lastErr instanceof Error ? lastErr : new Error('RPC failed')
    pending.forEach(([, waiters]) => waiters.forEach(w => w.no(err)))
  }
}

function flush() {
  timer = null
  while (queue.length) {
    const group = queue.splice(0, BATCH_MAX)
    void sendBatch(group)
  }
}

const NO_CACHE = new Set(['octra_transaction', 'octra_search', 'contract_receipt'])

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const key = keyOf(method, params)
  const hit = NO_CACHE.has(method) ? undefined : fresh.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
  return new Promise<T>((ok, no) => {
    queue.push({ method, params, key, ok: v => ok(v as T), no })
    if (queue.length >= BATCH_MAX) {
      if (timer) { clearTimeout(timer); timer = null }
      queueMicrotask(flush)
    } else if (!timer) timer = setTimeout(flush, BATCH_WINDOW_MS)
  })
}

export function forgetReads() { fresh.clear() }

export async function getRecommendedFee(opType: string): Promise<number> {
  try {
    const r = await rpc<{ recommended?: string; base_fee?: string }>('octra_recommendedFee', [opType])
    return Number(r.recommended ?? r.base_fee ?? 0) || 0
  } catch { return 0 }
}

export function parseTuple(encoded: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < encoded.length) {
    let lenStr = ''
    while (i < encoded.length && encoded[i] !== '#') lenStr += encoded[i++]
    i++
    const len = parseInt(lenStr, 10)
    result.push(encoded.slice(i, i + len))
    i += len
  }
  return result
}

export async function contractCall<T = unknown>(
  address: string,
  method: string,
  params: unknown[] = [],
  caller = ''
): Promise<T> {
  const envelope = await rpc<{ result: T }>('contract_call', [address, method, params, caller])
  return envelope.result
}

const READER_DEFAULT = 'octFpb6zpMR7dHQ1zJWqkRJxCP9yBmQnNUxzs6H47UByhPR'
function readerAddr(): string {
  try { return localStorage.getItem('oct_tokenreader_addr') ?? READER_DEFAULT } catch { return READER_DEFAULT }
}

const THROUGH_READER: Record<string, string> = { balance_of: 'bal', allowance_of: 'allow' }

export async function contractCallView<T = unknown>(
  address: string,
  method: string,
  params: unknown[] = [],
  caller = ''
): Promise<T> {
  const through = THROUGH_READER[method]
  const reader = through ? readerAddr() : ''
  if (reader) {
    try {
      const viaRaw = await rpc<unknown>('contract_call', [reader, through, [address, ...params], caller])
      const via = (viaRaw !== null && typeof viaRaw === 'object' && 'result' in (viaRaw as object))
        ? (viaRaw as { result: unknown }).result
        : viaRaw
      if (via !== null && via !== undefined && String(via) !== '') return via as T
    } catch {  }
  }

  const raw = await rpc<unknown>('contract_call', [address, method, params, caller])
  if (DBG) console.log(`[contractCallView] ${method} @ ${address.slice(0, 12)}... raw=`, JSON.stringify(raw))
  if (raw !== null && typeof raw === 'object' && 'result' in (raw as object)) {
    return (raw as { result: T }).result
  }
  return raw as T
}

export async function contractCallTuple(
  address: string,
  method: string,
  params: unknown[] = [],
  caller = ''
): Promise<string[]> {
  const envelope = await rpc<{ result: string }>('contract_call', [address, method, params, caller])
  return parseTuple(envelope.result)
}

const WEBCLI_URL = '/webcli'

const DBG = (() => { try { return localStorage.getItem('oct_debug') === '1' } catch { return false } })()

export interface CallTxParams {
  from: string
  privateKey: string
  contract: string
  method: string
  params: unknown[]
  amount?: number
  nonce?: number
  ou?: string
}

export async function submitCallTx(p: CallTxParams): Promise<string> {
  const { contract, method, params, amount = 0 } = p
  const octra = getOctra()
  if (!octra) throw new Error('Factory Wallet not found — connect it first')
  const r = await octra.call(contract, method, params as (string | number)[], amount)
  return r.hash
}

export interface MultiExecCall {
  address: string
  method:  string
  params:  unknown[]
  amount?: string
}

export const BATCH_LIMIT = 8

export async function submitMultiExec(calls: MultiExecCall[], _ou = '8000', _pin = ''): Promise<string> {
  const octra = getOctra()
  if (!octra) throw new Error('Factory Wallet not found — connect it first')
  if (calls.length > BATCH_LIMIT) {
    throw new Error(
      `one transaction can hold at most ${BATCH_LIMIT} calls, this one has ${calls.length} — split it`)
  }
  if (!calls.length) throw new Error('nothing to submit')
  const mapped = calls.map(c => ({ to: c.address, method: c.method, params: c.params, value: c.amount ?? '0' }))
  const r = await octra.multiExec(mapped)
  return r.hash
}

export interface DeployResult {
  hash: string
  contractAddress?: string
}

export async function submitDeploy(
  _from: string,
  _privateKey: string,
  bytecodeB64: string,
  constructorParams: unknown[]
): Promise<DeployResult> {
  const octra = getOctra()
  if (octra?.deploy) {
    const r = await octra.deploy(bytecodeB64, constructorParams as (string | number)[], '400000')
    if (!r?.hash) throw new Error('wallet deploy returned no tx hash')
    return { hash: r.hash, contractAddress: r.contractAddress }
  }

  if (!import.meta.env.DEV) {
    throw new Error('creating a pool needs Factory Wallet: the 0xio wallet cannot deploy contracts')
  }

  const body = {
    bytecode: bytecodeB64,
    params: JSON.stringify(constructorParams),
    ou: '400000',
  }

  const res = await fetch(`${WEBCLI_URL}/api/contract/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v),
  })

  const rawText = await res.text()
  if (!res.ok) throw new Error(`webcli error ${res.status}: ${rawText}`)

  let json: Record<string, unknown>
  try { json = JSON.parse(rawText) } catch { throw new Error('webcli non-JSON deploy response: ' + rawText) }

  if (json.error) throw new Error((json.error as { message?: string }).message ?? String(json.error))
  const hash = (json.tx_hash || json.hash) as string | undefined
  if (!hash) throw new Error('no tx_hash in webcli deploy response: ' + rawText)

  const contractAddress = (
    json.contract_address ?? json.address ?? json.new_address ?? json.deployed_address
  ) as string | undefined

  return { hash, contractAddress }
}

export interface Receipt {
  success: boolean
  result?: unknown
  error?: string
  effort: number
  events: { name: string; args: unknown[] }[]
}

export async function getReceipt(hash: string): Promise<Receipt | null> {
  try {
    return await rpc<Receipt>('contract_receipt', [hash])
  } catch {
    return null
  }
}

export async function waitForReceipt(hash: string, timeoutMs = 30_000): Promise<Receipt> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await getReceipt(hash)
    if (r) { forgetReads(); return r }
    await new Promise(res => setTimeout(res, 800))
  }
  const status = await getTxStatus(hash).catch(() => '')
  if (status === 'rejected' || status === 'failed' || status === 'dropped') {
    throw new Error(`the network rejected this transaction (${status})`)
  }
  const stalled = await (async () => {
    try {
      const a = await getCurrentEpoch()
      await new Promise(res => setTimeout(res, 6000))
      return (await getCurrentEpoch()) === a
    } catch { return false }
  })()
  if (stalled) {
    throw new Error(
      `the network is not producing epochs right now, so nothing can confirm. ` +
      `your transaction (${hash.slice(0, 10)}…) is queued and will go through when the chain moves. ` +
      `do NOT send it again — you would pay twice.`
    )
  }
  throw new Error(
    `the network has not confirmed this yet (${hash.slice(0, 10)}…). it may still go through — ` +
    `check the explorer before trying again, or you could pay twice.`
  )
}

export async function getTxStatus(hash: string): Promise<string> {
  try {
    const r = await rpc<{ status?: string } | null>('octra_search', [hash])
    return r?.status ?? ''
  } catch { return '' }
}

export async function compileAml(source: string): Promise<{ bytecode: string; abi: unknown }> {
  return rpc('octra_compileAml', [source])
}

export async function getCodeHash(address: string): Promise<string> {
  try {
    const r = await rpc<{ code_hash?: string } | null>('vm_contract', [address])
    return (r && typeof r === 'object' && r.code_hash) ? r.code_hash : ''
  } catch { return '' }
}

export async function getBalance(address: string): Promise<{ balance: string; nonce: number }> {
  return rpc('octra_balance', [address])
}

export async function getCurrentEpoch(): Promise<number> {
  return rpc<number>('epoch_current', [])
}

export const SEC_PER_EPOCH = 12

export async function getEpochId(): Promise<number> {
  const r = await rpc<{ epoch_id?: number } | null>('epoch_current', [])
  return Number(r?.epoch_id ?? 0)
}

export interface TokenBalance {
  address:  string
  symbol:   string
  name:     string
  decimals: number
  balance:  string
}
