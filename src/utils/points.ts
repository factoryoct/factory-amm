import { getOctra } from './walletOctra'

const INDEXER = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

export interface PointsBreakdown {
  liquidity:    number
  publicSwaps:  number
  relayer:      number
  referrals:    number
}

export interface PointsInfo {
  wallet:        string
  total:         number
  streak:        number
  streakMult:    number
  tier:          string
  tierMult:      number
  breakdown:     PointsBreakdown
  referralCount: number
}

export interface LeaderRow {
  rank:      number
  wallet:    string
  total:     number
  swaps:     number
  volume:    number
  liquidity: number
  streak:    number
  tier:      string
}

export type LeaderCategory = 'overall' | 'swaps' | 'volume' | 'liquidity'

export async function getPoints(wallet: string): Promise<PointsInfo | null> {
  if (!INDEXER || !wallet) return null
  try {
    const res = await fetch(`${INDEXER}/?points=${encodeURIComponent(wallet)}`)
    if (!res.ok) return null
    return await res.json() as PointsInfo
  } catch { return null }
}

export async function getLeaderboard(category: LeaderCategory = 'overall', limit = 100): Promise<LeaderRow[]> {
  if (!INDEXER) return []
  try {
    const res = await fetch(`${INDEXER}/?leaderboard=${category}&limit=${limit}`)
    if (!res.ok) return []
    return await res.json() as LeaderRow[]
  } catch { return [] }
}

async function signRequest(referee: string, referrer: string):
    Promise<{ ts: number; pubkey: string; sig: string } | null> {
  const pv = getOctra()
  if (!pv || typeof pv.signMessage !== 'function' || typeof pv.publicKey !== 'function') return null
  try {
    const ts = Date.now()
    const newline = String.fromCharCode(10)
    const message =
      'factory-amm referral' + newline +
      'referee: ' + referee + newline +
      'referrer: ' + referrer + newline +
      'ts: ' + ts
    const pubkey = await pv.publicKey()
    const sig = await pv.signMessage(message)
    if (!pubkey || !sig) return null
    return { ts, pubkey, sig }
  } catch { return null }
}

export async function setReferral(referee: string, referrer: string): Promise<void> {
  if (!INDEXER || !referee || !referrer || referee === referrer) return
  const proof = await signRequest(referee, referrer)
  if (!proof) return
  try {
    await fetch(`${INDEXER}/?referral=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referee, referrer, ...proof }),
    })
  } catch {  }
}

export async function getReferralCode(address: string): Promise<string | null> {
  if (!INDEXER || !address) return null
  try {
    const res = await fetch(`${INDEXER}/?refcode=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    if (!res.ok) return null
    const j = await res.json() as { code?: string }
    return j.code ?? null
  } catch { return null }
}

export async function setReferralByCode(referee: string, code: string): Promise<void> {
  if (!INDEXER || !referee || !code) return
  const proof = await signRequest(referee, 'code:' + code)
  if (!proof) return
  try {
    await fetch(`${INDEXER}/?referral=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referee, code, ...proof }),
    })
  } catch {  }
}
