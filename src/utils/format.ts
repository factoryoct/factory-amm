export function shortenAddress(addr: string, chars = 6): string {
  if (!addr) return ''
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`
}

export function formatNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(n)
}

export function timeAgo(epochSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSec
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function feeToPercent(feePips: number): string {
  return (feePips / 10000).toFixed(2) + '%'
}

export function formatCompact(value: number): string {
  if (value >= 1e9)  return (value / 1e9).toFixed(2) + 'B'
  if (value >= 1e6)  return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3)  return (value / 1e3).toFixed(2) + 'K'
  if (value > 0 && value < 0.01) return value.toPrecision(2)
  return value.toFixed(2)
}

export function toBaseUnits(text: string, decimals: number): bigint {
  const t = String(text ?? '').trim().replace(',', '.')
  if (t === '' || !/^\d*(\.\d*)?$/.test(t)) return 0n
  const [intPart = '', frac = ''] = t.split('.')
  const tail = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt((intPart || '0') + tail)
}

export function fromBaseUnits(units: bigint, decimals: number): string {
  const sign = units < 0n ? '-' : ''
  const s = (units < 0n ? -units : units).toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals)
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : ''
  return sign + intPart + (frac ? '.' + frac : '')
}

const toBasisPoints = (percent: number): bigint => {
  const pv = Number.isFinite(percent) ? percent : 0
  return BigInt(Math.round(Math.min(Math.max(pv, 0), 100) * 100))
}
export function bumpDown(units: bigint, percent: number): bigint {
  return units * (10000n - toBasisPoints(percent)) / 10000n
}
export function bumpUp(units: bigint, percent: number): bigint {
  const upper = units * (10000n + toBasisPoints(percent))
  return upper % 10000n === 0n ? upper / 10000n : upper / 10000n + 1n
}
