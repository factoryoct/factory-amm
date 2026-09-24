export const FEE_RESERVE = 50_000n

export function spendableNative(total: bigint, feeEstimateCoins = 0): bigint {
  const byEstimate = BigInt(Math.ceil(Math.max(feeEstimateCoins, 0) * 2 * 1e6))
  const reserve = byEstimate > FEE_RESERVE ? byEstimate : FEE_RESERVE
  return total > reserve ? total - reserve : 0n
}

export function formatBaseUnits(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0'
  const unit = 10n ** BigInt(decimals)
  const whole = raw / unit
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
