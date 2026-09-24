
interface Sample { ts: number; p: number }
const KEY  = 'oct_fact_price_hist'
const DAY  = 86_400_000
const MIN_AGE = 12 * 3600 * 1000

function load(): Sample[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function recordFactPrice(p: number): void {
  if (!(p > 0)) return
  try {
    const arr = load()
    const now = Date.now()
    if (arr.length && now - arr[arr.length - 1].ts < 10 * 60 * 1000) return
    arr.push({ ts: now, p })
    const cutoff = now - 26 * 3600 * 1000
    localStorage.setItem(KEY, JSON.stringify(arr.filter(s => s.ts >= cutoff)))
  } catch {  }
}

export function getFactChange24h(current: number): number | null {
  if (!(current > 0)) return null
  const arr = load().filter(s => s.ts <= Date.now() - MIN_AGE && s.p > 0)
  if (!arr.length) return null
  const target = Date.now() - DAY
  let best = arr[0]
  for (const s of arr) if (Math.abs(s.ts - target) < Math.abs(best.ts - target)) best = s
  return (current - best.p) / best.p * 100
}
