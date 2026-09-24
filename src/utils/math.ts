
export const Q96 = BigInt('79228162514264337593543950336')

const SCALE = 1000000000000n

export function sqrtPriceToPrice(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): number {
  const intVal = (sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(token0Decimals) * SCALE) / (Q96 * Q96)
  return Number(intVal) / 1e12 / 10 ** token1Decimals
}

export function priceToSqrtPriceX96(price: number): bigint {
  const sqrtPrice = Math.sqrt(price)
  return BigInt(Math.floor(sqrtPrice * Number(Q96)))
}

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick)
}

export function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001))
}

export function nearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing
  const upper = Math.floor(887272 / tickSpacing) * tickSpacing
  const lower  = -upper
  return Math.max(lower, Math.min(upper, rounded))
}

export function formatCompact(value: number): string {
  if (value >= 1e9)  return (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6)  return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3)  return (value / 1e3).toFixed(2) + 'K'
  return value.toFixed(2)
}

export function getAmount0(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA]
  return liquidity * Q96 * (hi - lo) / hi / lo
}

export function getAmount1(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA]
  return liquidity * (hi - lo) / Q96
}

export function getLiquidityForAmounts(
  sqrtCurrent: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
  amount0: bigint,
  amount1: bigint
): bigint {
  const sqrtP = sqrtCurrent < sqrtLower ? sqrtLower : sqrtCurrent > sqrtUpper ? sqrtUpper : sqrtCurrent

  let liq0 = 0n
  let liq1 = 0n

  if (sqrtUpper > sqrtP) {
    liq0 = amount0 * sqrtP / Q96 * sqrtUpper / (sqrtUpper - sqrtP)
  }
  if (sqrtP > sqrtLower) {
    liq1 = amount1 * Q96 / (sqrtP - sqrtLower)
  }

  if (liq0 === 0n) return liq1
  if (liq1 === 0n) return liq0
  return liq0 < liq1 ? liq0 : liq1
}
