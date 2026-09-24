const OWN = 'https://api.factory-amm.xyz/price'
const FALLBACK = 'https://api.coingecko.com/api/v3/simple/price?ids=octra&vs_currencies=usd&include_24hr_change=true'

const HEADERS = {
  accept: 'application/json',
  'user-agent': 'factory-amm/1.0 (+https://app.factory-amm.xyz)',
}

const empty = () => new Response('{}', {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

const ok = body => new Response(body, {
  status: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
  },
})

async function fetchPrice(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
  if (!res.ok) return ''
  const body = await res.text()
  let price = 0
  try { price = JSON.parse(body)?.octra?.usd ?? 0 } catch { price = 0 }
  return price > 0 ? body : ''
}

export async function onRequestGet() {
  for (const url of [OWN, FALLBACK]) {
    try {
      const body = await fetchPrice(url)
      if (body) return ok(body)
    } catch {}
  }
  return empty()
}
