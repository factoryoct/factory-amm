import { contractCallTuple } from './rpc'
import { CONTRACTS } from '../context/WalletContext'
import { SEC_PER_EPOCH } from './rpc'

export interface Estimate {
  tick: number
  price: number
  depth: number
  pools: number
  ageEpochs: number
  spread: number
}

export const deviationPercent = (spread: number) => (Math.pow(1.0001, Math.abs(spread)) - 1) * 100

export const ALARM = 0.5

export async function estimate(
  tokenA: string,
  tokenB: string,
  epochWindow: number,
): Promise<Estimate | null> {
  const priceMap = CONTRACTS.oracle
  if (!priceMap || !tokenA || !tokenB) return null
  try {
    const arr = await contractCallTuple(priceMap, 'quote', [tokenA, tokenB, String(epochWindow)])
    if (arr.length < 5) return null
    const tick = Number(arr[0])
    if (!Number.isFinite(tick)) return null
    return {
      tick,
      price: Math.pow(1.0001, tick),
      depth: Number(arr[1]) || 0,
      pools: Number(arr[2]) || 0,
      ageEpochs: Number(arr[3]) || 0,
      spread: Number(arr[4]) || 0,
    }
  } catch {
    return null
  }
}

export const windowByHours = (hours: number) =>
  Math.max(4, Math.round((hours * 3600) / (SEC_PER_EPOCH || 12)))

export async function estimateStrict(
  tokenA: string,
  tokenB: string,
  epochWindow: number,
  maxEpochAge: number,
  maxTickGap: number,
): Promise<Estimate | null> {
  const priceMap = CONTRACTS.oracle
  if (!priceMap || !tokenA || !tokenB) return null
  try {
    const arr = await contractCallTuple(priceMap, 'quote_safe', [
      tokenA, tokenB, String(epochWindow),
      String(maxEpochAge), String(maxTickGap),
    ])
    if (arr.length < 5) return null
    const tick = Number(arr[0])
    if (!Number.isFinite(tick)) return null
    return {
      tick,
      price: Math.pow(1.0001, tick),
      depth: Number(arr[1]) || 0,
      pools: Number(arr[2]) || 0,
      ageEpochs: Number(arr[3]) || 0,
      spread: Number(arr[4]) || 0,
    }
  } catch {
    return null
  }
}
