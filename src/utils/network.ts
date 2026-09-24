import { rpc } from './rpc'

export interface NetState {
  epoch: number
  finalized: number
  version: string
  txTotal: number
  secondsPerEpoch: number | null
  stalled: boolean
}

interface Reply {
  epoch?: number
  current_epoch?: number
  head_epoch?: number
  network_version?: string
  txid_hi?: string | number
}

let lastEpoch = 0
let lastTime = 0

const STALL_MS = 90_000

export async function netState(): Promise<NetState | null> {
  let it: Reply | null = null
  try { it = await rpc<Reply>('node_status', []) } catch { return null }
  if (!it) return null

  const epoch = Number(it.current_epoch ?? it.epoch ?? 0)
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  const now = Date.now()

  let secondsPerEpoch: number | null = null
  let stalled = false
  if (lastEpoch > 0) {
    const elapsed = (now - lastTime) / 1000
    const epochs = epoch - lastEpoch
    if (epochs > 0 && elapsed > 0) secondsPerEpoch = elapsed / epochs
    else if (now - lastTime > STALL_MS) stalled = true
  }
  if (epoch > lastEpoch) { lastEpoch = epoch; lastTime = now }

  return {
    epoch,
    finalized: Number(it.head_epoch ?? 0) || 0,
    version: String(it.network_version ?? ''),
    txTotal: Number(it.txid_hi ?? 0) || 0,
    secondsPerEpoch,
    stalled,
  }
}
