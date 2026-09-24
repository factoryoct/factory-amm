
import { contractCallView } from './rpc'
import { CONTRACTS } from '../context/WalletContext'

export interface TokenLook {
  image: string
  x:     string
  site:  string
  about: string
}

const EMPTY_LOOK: TokenLook = { image: '', x: '', site: '', about: '' }

export function unpackLook(body: string): TokenLook {
  const out: string[] = []
  let i = 0
  while (i < body.length && out.length < 4) {
    const h = body.indexOf('#', i)
    if (h < 0) break
    const n = Number(body.slice(i, h))
    if (!Number.isFinite(n) || n < 0) break
    out.push(body.slice(h + 1, h + 1 + n))
    i = h + 1 + n
  }
  return { image: out[0] ?? '', x: out[1] ?? '', site: out[2] ?? '', about: out[3] ?? '' }
}

export function safeUrl(raw: string): string {
  const v = (raw || '').trim()
  if (!v) return ''
  if (!/^https:\/\/[^\s"'<>]+$/i.test(v)) return ''
  return v
}

const cache = new Map<string, TokenLook>()
const inflight = new Map<string, Promise<TokenLook>>()

export async function loadLook(token: string): Promise<TokenLook> {
  if (!token) return EMPTY_LOOK
  const hit = cache.get(token)
  if (hit) return hit
  const running = inflight.get(token)
  if (running) return running

  const store = CONTRACTS.tokenMeta
  if (!store) return EMPTY_LOOK

  const task = (async () => {
    try {
      const body = await contractCallView<string>(store, 'get', [token])
      const look = unpackLook(String(body ?? ''))
      cache.set(token, look)
      return look
    } catch {
      return EMPTY_LOOK
    } finally {
      inflight.delete(token)
    }
  })()
  inflight.set(token, task)
  return task
}
