const NODE = 'https://devnet.octrascan.io/rpc'

export async function onRequestPost({ request }) {
  const body = await request.text()
  const res = await fetch(NODE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, node: NODE }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
