import { useState, useEffect, useCallback, useRef } from 'react'
import PageHead, { Page } from '../components/PageHead'
import { Link } from 'react-router-dom'
import { useWallet, CONTRACTS } from '../context/WalletContext'
import { contractCallTuple, contractCallView, getReceipt, getTxStatus, getOctPrice, submitMultiExec, type MultiExecCall, lastOctPrice } from '../utils/rpc'
import { getTokenPricesUsd } from '../utils/price'
import { getPoints, type PointsInfo } from '../utils/points'
import { tickToPrice, priceToSqrtPriceX96, getAmount0, getAmount1, sqrtPriceToPrice, getLiquidityForAmounts, Q96 } from '../utils/math'
import { formatNumber, feeToPercent, toBaseUnits } from '../utils/format'
import { saveLPHistory, loadCollectedFees } from '../utils/lpHistory'
import { fetchPositions, deletePosition, type SavedPos } from '../utils/positions'
import { tokenSymbol } from '../config/tokens'
import { getAllPools } from '../utils/pools'
import { mapLimit } from '../utils/concurrency'

const M = 'var(--oct-type-mono)'
const F = 'var(--oct-type-ui)'
const POOL_INDEXER_URL = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

interface Position extends SavedPos {
  liquidity:   bigint
  owed0:       bigint
  owed1:       bigint
  currentTick: number
  sqrtPrice:   bigint
  inRange:     boolean
  amount0:     bigint
  amount1:     bigint
  token0:      string
  token1:      string
  fee:         number
  poolApr:     number
  poolFees24hUsd: number
  poolActiveLiq:  bigint
}

async function loadPoolMeta(pool: string, octP: number): Promise<{
  sqrtPrice: bigint; currentTick: number; token0: string; token1: string; fee: number
  apr: number; fees24hUsd: number; activeLiq: bigint
}> {
  const [slot0, tokens, config, liqStr] = await Promise.all([
    contractCallTuple(pool, 'get_slot0', []),
    contractCallTuple(pool, 'get_tokens', []).catch(() => null),
    contractCallTuple(pool, 'get_config', []).catch(() => null),
    contractCallView<string>(pool, 'get_liquidity', []).catch(() => '0'),
  ])
  const sqrtPrice   = BigInt(slot0[0])
  const currentTick = Number(slot0[1])
  const token0 = tokens?.[0] ?? CONTRACTS.woct
  const token1 = tokens?.[1] ?? CONTRACTS.fact
  const fee    = config ? Number(config[0]) : 3000
  let activeLiq = 0n; try { activeLiq = BigInt(liqStr || '0') } catch {  }

  let apr = 0, fees24hUsd = 0
  if (POOL_INDEXER_URL && octP > 0) {
    try {
      const poolPrice = sqrtPriceToPrice(sqrtPrice, 6, 6)
      if (poolPrice > 0) {
        const prices = await getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, octP, CONTRACTS.router)
        const p0 = token0 === CONTRACTS.woct ? octP : (prices[token0] ?? 0)
        const p1 = token1 === CONTRACTS.woct ? octP : (prices[token1] ?? 0)
        const [b0, b1, m] = await Promise.all([
          contractCallView<string>(token0, 'balance_of', [pool]),
          contractCallView<string>(token1, 'balance_of', [pool]),
          fetch(`${POOL_INDEXER_URL}?pool=${pool}`).then(r => r.ok ? r.json() as Promise<{ vol0: string; vol1: string }> : null).catch(() => null),
        ])
        const tvl = (Number(b0) / 1e6) * p0 + (Number(b1) / 1e6) * p1
        if (m) {
          const volume = (Number(m.vol0) / 1e6) * p0 + (Number(m.vol1) / 1e6) * p1
          fees24hUsd = volume * (fee / 1_000_000)
          if (tvl >= 1 && fees24hUsd > 0) apr = Math.min((fees24hUsd * 365 / tvl) * 100, 100_000)
        }
      }
    } catch {  }
  }
  return { sqrtPrice, currentTick, token0, token1, fee, apr, fees24hUsd, activeLiq }
}

const POS_KEY = (a: string) => `oct_positions_v1_${a}`
const POS_BIGINTS = ['liquidity', 'owed0', 'owed1', 'sqrtPrice', 'amount0', 'amount1', 'poolActiveLiq'] as const
function readPosCache(a: string): Position[] {
  if (!a) return []
  try {
    const raw = localStorage.getItem(POS_KEY(a)); if (!raw) return []
    return (JSON.parse(raw) as Record<string, unknown>[]).map(p => {
      const o: Record<string, unknown> = { ...p }
      for (const k of POS_BIGINTS) o[k] = BigInt((p[k] as string) ?? '0')
      return o as unknown as Position
    })
  } catch { return [] }
}
function writePosCache(a: string, positions: Position[]) {
  if (!a) return
  try { localStorage.setItem(POS_KEY(a), JSON.stringify(positions, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) }
  catch {  }
}

const PTS_KEY = (a: string) => `oct_points_v1_${a}`
function readPtsCache(a: string): PointsInfo | null {
  if (!a) return null
  try { const raw = localStorage.getItem(PTS_KEY(a)); return raw ? JSON.parse(raw) as PointsInfo : null } catch { return null }
}
function writePtsCache(a: string, p: PointsInfo | null) {
  if (!a || !p) return
  try { localStorage.setItem(PTS_KEY(a), JSON.stringify(p)) } catch {  }
}

export default function MyPositions() {
  const { address, connected, openConnectModal, addToast, callContract, setBusy, balance: nativeBalance, connectMethod, getSessionPin, clearSessionPin } = useWallet()
  const [positions, setPositions]   = useState<Position[]>(() => readPosCache(address))
  const [pts, setPts]               = useState<PointsInfo | null>(() => readPtsCache(address))
  const [ptsOpen, setPtsOpen]       = useState(() => { try { return localStorage.getItem('oct_pts_collapsed') !== '1' } catch { return true } })
  const togglePts = () => setPtsOpen(o => { const n = !o; try { localStorage.setItem('oct_pts_collapsed', n ? '0' : '1') } catch {} ; return n })
  const [loading, setLoading]       = useState(() => readPosCache(address).length === 0)
  const [, setReloading]            = useState(false)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [octPrice, setOctPrice]     = useState(lastOctPrice)
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({})
  const [burnModal, setBurnModal]   = useState<{ pos: Position; pct: number } | null>(null)
  const [mintModal, setMintModal]   = useState<{ pos: Position; input0: string; input1: string; bal0: string; bal1: string; minting: boolean } | null>(null)
  const collectedAt = useRef<Map<string, number>>(new Map())
  const posKey = (p: { pool: string; tickLower: number; tickUpper: number }) => `${p.pool}-${p.tickLower}-${p.tickUpper}`
  const COLLECT_GRACE_MS = 12000
  const pinCollected = (list: Position[]): Position[] => {
    const now = Date.now()
    return list.map(p => {
      const ts = collectedAt.current.get(posKey(p))
      if (ts === undefined) return p
      if (p.owed0 === 0n && p.owed1 === 0n) { collectedAt.current.delete(posKey(p)); return p }
      if (now - ts < COLLECT_GRACE_MS) return { ...p, owed0: 0n, owed1: 0n }
      collectedAt.current.delete(posKey(p))
      return p
    })
  }

  useEffect(() => { getOctPrice().then(setOctPrice).catch(() => {}) }, [])

  const [collectedBySym, setCollectedBySym] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!connected || !address) { setCollectedBySym({}); return }
    let cancelled = false
    loadCollectedFees(address)
      .then(acc => { if (!cancelled) setCollectedBySym(acc) })
      .catch(() => { if (!cancelled) setCollectedBySym({}) })
    return () => { cancelled = true }
  }, [connected, address])

  const loadPositions = useCallback(async () => {
    if (!address) return
    const poolsP = getAllPools(CONTRACTS.factory).catch(() => [])
    const savedP = fetchPositions(address).catch(() => [])
    const priceP = getOctPrice().catch(() => 0)

    const cachedAll = pinCollected(readPosCache(address))
    if (cachedAll.length > 0) setPositions(cachedAll)
    setLoading(cachedAll.length === 0)
    setReloading(true)

    const all = await poolsP
    const livePools = new Set(all.filter(p => !p.router || p.router === CONTRACTS.router).map(p => p.address))
    const inFactory = (p: { pool: string }) => livePools.size === 0 || livePools.has(p.pool)
    const cached = cachedAll.filter(inFactory)
    if (cached.length !== cachedAll.length) setPositions(cached)
    const saved = (await savedP).filter(inFactory)
    if (saved.length === 0) {
      setPositions([]); writePosCache(address, []); setLoading(false); setReloading(false); return
    }

    const octP = await priceP

    interface PoolMeta { sqrtPrice: bigint; currentTick: number; token0: string; token1: string; fee: number; apr: number; fees24hUsd: number; activeLiq: bigint }
    const metaCache = new Map<string, Promise<PoolMeta>>()
    const getPoolMeta = (pool: string): Promise<PoolMeta> => {
      let p = metaCache.get(pool)
      if (!p) { p = loadPoolMeta(pool, octP); metaCache.set(pool, p) }
      return p
    }

    const results = await mapLimit(saved, 6, async (s): Promise<Position | null> => {
      try {
        const [posTuple, meta] = await Promise.all([
          contractCallTuple(s.pool, 'get_position', [address, String(s.tickLower), String(s.tickUpper)]),
          getPoolMeta(s.pool),
        ])
        const [liq, rawOw0, rawOw1] = posTuple
        const { sqrtPrice, currentTick, token0, token1, fee, apr: poolApr, fees24hUsd, activeLiq } = meta

        const liquidity = BigInt(liq)
        const sqrtL = priceToSqrtPriceX96(tickToPrice(s.tickLower))
        const sqrtU = priceToSqrtPriceX96(tickToPrice(s.tickUpper))
        const sqrtC = sqrtPrice < sqrtL ? sqrtL : sqrtPrice > sqrtU ? sqrtU : sqrtPrice

        const amount0 = liquidity > 0n ? getAmount0(sqrtC, sqrtU, liquidity) : 0n
        const amount1 = liquidity > 0n ? getAmount1(sqrtL, sqrtC, liquidity) : 0n

        let owed0 = BigInt(rawOw0 || '0')
        let owed1 = BigInt(rawOw1 || '0')
        if (liquidity > 0n) {
          try {
            const [p0, p1] = await contractCallTuple(s.pool, 'get_pending_fees', [address, String(s.tickLower), String(s.tickUpper)])
            const pf0 = BigInt(p0) > 0n ? BigInt(p0) : 0n
            const pf1 = BigInt(p1) > 0n ? BigInt(p1) : 0n
            if (pf0 > owed0) owed0 = pf0
            if (pf1 > owed1) owed1 = pf1
          } catch {  }
        }

        return {
          ...s,
          liquidity,
          owed0,
          owed1,
          currentTick,
          sqrtPrice,
          inRange:  (() => {
          const p = sqrtPriceToPrice(sqrtPrice, 6, 6)
          return p >= tickToPrice(s.tickLower) && p < tickToPrice(s.tickUpper)
        })(),
          amount0,
          amount1,
          token0, token1, fee, poolApr,
          poolFees24hUsd: fees24hUsd, poolActiveLiq: activeLiq,
        }
      } catch {
        return null
      }
    })
    const loaded: Position[] = pinCollected(results.filter((p): p is Position => p !== null))
    for (const s of saved) {
      const match = loaded.find(p => p.pool === s.pool && p.tickLower === s.tickLower && p.tickUpper === s.tickUpper)
      if (match && match.liquidity === 0n && match.owed0 === 0n && match.owed1 === 0n) {
        deletePosition(address, s.pool, s.tickLower, s.tickUpper)
      }
    }
    const fresh = loaded.filter(p => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n)
    setPositions(fresh)
    writePosCache(address, fresh)
    setLoading(false)
    setReloading(false)
  }, [address])

  useEffect(() => {
    if (connected && address) loadPositions()
  }, [connected, address, loadPositions])

  useEffect(() => {
    if (connected && address) getPoints(address).then(p => { setPts(p); writePtsCache(address, p) }).catch(() => {})
    else setPts(null)
  }, [connected, address])

  async function pollReceipt(hash: string, timeoutMs = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 800))
      const r = await getReceipt(hash)
      if (r) return r
    }
    const status = await getTxStatus(hash).catch(() => '')
    if (status === 'rejected' || status === 'failed' || status === 'dropped') return null
    throw new Error(
      `the network has not confirmed this yet (${hash.slice(0, 10)}…). it may still go through — ` +
      `check the explorer before trying again, or you could pay twice.`
    )
  }

  async function maybeUnwrap(token: string, amount: bigint) {
    if (token !== CONTRACTS.woct || amount <= 0n) return
    let amt = amount
    try {
      const woctBal = BigInt(await contractCallView<string>(CONTRACTS.woct, 'balance_of', [address]))
      if (woctBal < amt) amt = woctBal
    } catch { return }
    if (amt <= 0n) return
    const { txHash: uh } = await callContract(CONTRACTS.woct, 'withdraw', [amt.toString()], '0', '5000')
    const ur = await pollReceipt(uh)
    if (ur && !ur.success) throw new Error(`unwrap OCT revert: ${ur.error ?? 'unknown'}`)
  }

  async function collectFromPool(pos: Position, req0: bigint, req1: bigint): Promise<{ ok0: boolean; ok1: boolean }> {
    if (req0 <= 0n && req1 <= 0n) return { ok0: false, ok1: false }
    addToast({ type: 'pending', message: 'collecting...' })
    const { txHash: h } = await callContract(pos.pool, 'collect',
      [address, String(pos.tickLower), String(pos.tickUpper), req0.toString(), req1.toString()], '0', '12000')
    const r = await pollReceipt(h)
    if (r && !r.success) throw new Error(`collect revert: ${r.error ?? 'unknown'}`)
    await maybeUnwrap(pos.token0, req0)
    await maybeUnwrap(pos.token1, req1)
    return { ok0: req0 > 0n, ok1: req1 > 0n }
  }

  function afterCollect(pos: Position, hash: string, owed0: bigint, owed1: bigint) {
    saveLPHistory(address, {
      type: 'collect', hash, timestamp: Date.now(),
      sym0: sym0(pos), sym1: sym1(pos),
      amt0: (Number(owed0) / 1e6).toFixed(4),
      amt1: (Number(owed1) / 1e6).toFixed(4),
    })
    collectedAt.current.set(posKey(pos), Date.now())
    setPositions(ps => ps.map(p2 =>
      p2.pool === pos.pool && p2.tickLower === pos.tickLower && p2.tickUpper === pos.tickUpper
        ? { ...p2, owed0: 0n, owed1: 0n }
        : p2
    ))
    addToast({ type: 'success', message: 'fees collected', txHash: hash })
  }

  async function collectAll() {
    if (actionPending) return
    const withFees = positions.filter(x => x.owed0 > 0n || x.owed1 > 0n)
    if (!withFees.length) { addToast({ type: 'success', message: 'nothing to collect' }); return }

    if (connectMethod !== 'key') {
      for (const x of withFees) {
        try { await collectFees(x) } catch {  }
      }
      await loadPositions()
      return
    }

    setActionPending('collect-all')
    setBusy(true)
    try {
      const ALL = '1000000000000000'
      const calls: MultiExecCall[] = []
      const owedBy = new Map<string, { p: Position; o0: bigint; o1: bigint }>()
      for (const x of withFees) {
        let o0 = x.owed0, o1 = x.owed1
        try {
          const [q0, q1] = await contractCallTuple(x.pool, 'get_pending_fees', [address, String(x.tickLower), String(x.tickUpper)])
          o0 = BigInt(q0); o1 = BigInt(q1)
        } catch {  }
        owedBy.set(posKey(x), { p: x, o0, o1 })
        calls.push({ address: x.pool, method: 'burn',    params: [String(x.tickLower), String(x.tickUpper), '0'], amount: '0' })
        calls.push({ address: x.pool, method: 'collect', params: [address, String(x.tickLower), String(x.tickUpper), ALL, ALL], amount: '0' })
      }
      let woct = 0n
      for (const { p: x, o0, o1 } of owedBy.values()) {
        if (x.token0 === CONTRACTS.woct) woct += o0
        if (x.token1 === CONTRACTS.woct) woct += o1
      }
      if (woct > 0n) calls.push({ address: CONTRACTS.woct, method: 'withdraw', params: [woct.toString()], amount: '0' })

      const LIMIT = 8
      const chunks: MultiExecCall[][] = []
      for (let i = 0; i < calls.length; i += LIMIT) chunks.push(calls.slice(i, i + LIMIT))

      let last = ''
      for (let i = 0; i < chunks.length; i++) {
        addToast({ type: 'pending', message: chunks.length > 1
          ? `collecting, part ${i + 1} of ${chunks.length}...`
          : `collecting from ${withFees.length} positions...` })
        const hash = await submitMultiExec(chunks[i], '400000', 'extension')
        const r = await pollReceipt(hash, 40000)
        if (r && !r.success) throw new Error(`collect revert: ${r.error ?? 'unknown'}`)
        if (!r) throw new Error(
          'the network has not confirmed this yet — check the explorer before trying again')
        last = hash
      }
      for (const { p: x, o0, o1 } of owedBy.values()) afterCollect(x, last, o0, o1)
    } catch (e) {
      addToast({ type: 'error', message: String((e as Error).message).slice(0, 180) })
    } finally {
      setActionPending(null)
      setBusy(false)
      void loadPositions()
    }
  }

  async function collectFees(pos: Position) {
    const key = `collect-${pos.pool}-${pos.tickLower}-${pos.tickUpper}`
    if (actionPending) return
    setActionPending(key)
    setBusy(true)
    try {
      let owed0 = pos.owed0, owed1 = pos.owed1
      try {
        const [p0, p1] = await contractCallTuple(pos.pool, 'get_pending_fees', [address, String(pos.tickLower), String(pos.tickUpper)])
        owed0 = BigInt(p0); owed1 = BigInt(p1)
      } catch {  }
      if (owed0 <= 0n && owed1 <= 0n) { addToast({ type: 'success', message: 'nothing to collect' }); return }

      const isW0 = pos.token0 === CONTRACTS.woct
      const isW1 = pos.token1 === CONTRACTS.woct

      if (connectMethod === 'key') {
        const ALL = '1000000000000000'
        const calls: MultiExecCall[] = [
          { address: pos.pool, method: 'burn',    params: [String(pos.tickLower), String(pos.tickUpper), '0'], amount: '0' },
          { address: pos.pool, method: 'collect', params: [address, String(pos.tickLower), String(pos.tickUpper), ALL, ALL], amount: '0' },
        ]
        if (isW0 && owed0 > 0n) calls.push({ address: CONTRACTS.woct, method: 'withdraw', params: [owed0.toString()], amount: '0' })
        if (isW1 && owed1 > 0n) calls.push({ address: CONTRACTS.woct, method: 'withdraw', params: [owed1.toString()], amount: '0' })

        addToast({ type: 'pending', message: 'collecting...' })
        const hash = await submitMultiExec(calls, '200000', 'extension')
        const r = await pollReceipt(hash, 30000)
        if (r && !r.success) throw new Error(`collect revert: ${r.error ?? 'unknown'}`)
        if (!r) throw new Error('collect timed out')
        afterCollect(pos, hash, owed0, owed1)
      } else {
        const { txHash: burnHash } = await callContract(pos.pool, 'burn',
          [String(pos.tickLower), String(pos.tickUpper), '0'], '0', '10000')
        const burnR = await pollReceipt(burnHash)
        if (!burnR?.success) throw new Error('fee snapshot failed: ' + (burnR?.error ?? 'no receipt'))

        await new Promise(r => setTimeout(r, 500))
        let claimOwed0 = pos.owed0, claimOwed1 = pos.owed1
        try {
          const [, f0, f1] = await contractCallTuple(pos.pool, 'get_position', [address, String(pos.tickLower), String(pos.tickUpper)])
          claimOwed0 = BigInt(f0); claimOwed1 = BigInt(f1)
        } catch {  }

        const res = await collectFromPool(pos, claimOwed0, claimOwed1)
        if (res.ok0 || res.ok1) afterCollect(pos, burnHash, claimOwed0, claimOwed1)
        else addToast({ type: 'success', message: 'nothing to collect' })
      }
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'collect failed' })
    } finally {
      setBusy(false)
      setActionPending(null)
      await new Promise(r => setTimeout(r, 1500))
      loadPositions()
    }
  }

  async function removeLiquidity(pos: Position, pct = 100) {
    if (pos.liquidity === 0n) {
      addToast({ type: 'error', message: 'no liquidity to remove' }); return
    }
    const liquidityToRemove = pct >= 100 ? pos.liquidity : pos.liquidity * BigInt(pct) / 100n
    if (liquidityToRemove === 0n) {
      addToast({ type: 'error', message: 'amount too small' }); return
    }
    const key = `burn-${pos.pool}-${pos.tickLower}-${pos.tickUpper}`
    if (actionPending) return
    setActionPending(key)
    setBusy(true)
    try {
      const isW0 = pos.token0 === CONTRACTS.woct
      const isW1 = pos.token1 === CONTRACTS.woct
      const removeAmt0 = pct >= 100 ? pos.amount0 : pos.amount0 * BigInt(pct) / 100n
      const removeAmt1 = pct >= 100 ? pos.amount1 : pos.amount1 * BigInt(pct) / 100n

      const onRemoved = (hash: string) => {
        saveLPHistory(address, {
          type: 'remove', hash, timestamp: Date.now(),
          sym0: sym0(pos), sym1: sym1(pos),
          amt0: (Number(removeAmt0) / 1e6).toFixed(4),
          amt1: (Number(removeAmt1) / 1e6).toFixed(4),
        })
        if (pct >= 100) {
          deletePosition(address, pos.pool, pos.tickLower, pos.tickUpper)
          setPositions(ps => ps.filter(p2 =>
            !(p2.pool === pos.pool && p2.tickLower === pos.tickLower && p2.tickUpper === pos.tickUpper)))
        } else {
          setPositions(ps => ps.map(p2 =>
            p2.pool === pos.pool && p2.tickLower === pos.tickLower && p2.tickUpper === pos.tickUpper
              ? { ...p2, owed0: 0n, owed1: 0n } : p2))
        }
        addToast({ type: 'success', message: pct >= 100 ? 'position closed' : 'liquidity removed', txHash: hash })
      }

      if (connectMethod === 'key') {
        let pf0 = 0n, pf1 = 0n
        try {
          const [a, b] = await contractCallTuple(pos.pool, 'get_pending_fees', [address, String(pos.tickLower), String(pos.tickUpper)])
          pf0 = BigInt(a); pf1 = BigInt(b)
        } catch {  }
        const ALL = '1000000000000000'
        const calls: MultiExecCall[] = [
          { address: pos.pool, method: 'burn',    params: [String(pos.tickLower), String(pos.tickUpper), liquidityToRemove.toString()], amount: '0' },
          { address: pos.pool, method: 'collect', params: [address, String(pos.tickLower), String(pos.tickUpper), ALL, ALL], amount: '0' },
        ]
        if (isW0 && removeAmt0 + pf0 > 0n) calls.push({ address: CONTRACTS.woct, method: 'withdraw', params: [(removeAmt0 + pf0).toString()], amount: '0' })
        if (isW1 && removeAmt1 + pf1 > 0n) calls.push({ address: CONTRACTS.woct, method: 'withdraw', params: [(removeAmt1 + pf1).toString()], amount: '0' })
        addToast({ type: 'pending', message: pct >= 100 ? 'closing position...' : 'removing liquidity...' })
        const hash = await submitMultiExec(calls, '300000', 'extension')
        const r = await pollReceipt(hash, 30000)
        if (r && !r.success) throw new Error('remove revert: ' + (r.error ?? 'unknown'))
        if (!r) throw new Error('remove timed out')
        onRemoved(hash)
      } else {
        const { txHash: burnHash } = await callContract(pos.pool, 'burn',
          [pos.tickLower, pos.tickUpper, liquidityToRemove.toString()], '0', '10000')
        const burnReceipt = await pollReceipt(burnHash)
        if (!burnReceipt?.success) throw new Error(burnReceipt?.error ?? 'burn failed')
        await new Promise(r => setTimeout(r, 500))
        const [, o0, o1] = await contractCallTuple(pos.pool, 'get_position', [address, String(pos.tickLower), String(pos.tickUpper)])
        await collectFromPool(pos, BigInt(o0), BigInt(o1))
        onRemoved(burnHash)
      }
    } catch (e: unknown) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'error' })
    } finally {
      setBusy(false)
      setActionPending(null)
      await new Promise(r => setTimeout(r, 1500))
      loadPositions()
    }
  }

  async function openMintModal(pos: Position) {
    if (actionPending) return
    setMintModal({ pos, input0: '', input1: '', bal0: '0', bal1: '0', minting: false })
    try {
      const b0 = pos.token0 === CONTRACTS.woct
        ? (nativeBalance || '0')
        : (await contractCallView<string>(pos.token0, 'balance_of', [address]).catch(() => '0') ?? '0')
      const b1 = await contractCallView<string>(pos.token1, 'balance_of', [address]).catch(() => '0') ?? '0'
      setMintModal(m => m ? { ...m, bal0: b0, bal1: b1 } : null)
    } catch {}
  }

  function mintInput0Change(val: string, pos: Position) {
    if (!val || isNaN(Number(val))) { setMintModal(m => m ? { ...m, input0: val, input1: '' } : null); return }
    const sqrtL = priceToSqrtPriceX96(tickToPrice(pos.tickLower))
    const sqrtU = priceToSqrtPriceX96(tickToPrice(pos.tickUpper))
    const sqrtC = pos.sqrtPrice
    const liq   = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, BigInt(Math.round(Number(val) * 1e6)), 0n)
    const a1    = sqrtC <= sqrtL ? 0n : getAmount1(sqrtL, sqrtC > sqrtU ? sqrtU : sqrtC, liq)
    setMintModal(m => m ? { ...m, input0: val, input1: (Number(a1) / 1e6).toFixed(6) } : null)
  }

  function mintInput1Change(val: string, pos: Position) {
    if (!val || isNaN(Number(val))) { setMintModal(m => m ? { ...m, input1: val, input0: '' } : null); return }
    const sqrtL = priceToSqrtPriceX96(tickToPrice(pos.tickLower))
    const sqrtU = priceToSqrtPriceX96(tickToPrice(pos.tickUpper))
    const sqrtC = pos.sqrtPrice
    const liq   = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, 0n, BigInt(Math.round(Number(val) * 1e6)))
    const a0    = sqrtC >= sqrtU ? 0n : getAmount0(sqrtC < sqrtL ? sqrtL : sqrtC, sqrtU, liq)
    setMintModal(m => m ? { ...m, input0: (Number(a0) / 1e6).toFixed(6), input1: val } : null)
  }

  async function addLiquidityToPosition(pos: Position, a0str: string, a1str: string) {
    if (!address) return
    const a0 = toBaseUnits(a0str, 6)
    const a1 = toBaseUnits(a1str, 6)
    if (a0 <= 0n && a1 <= 0n) return

    setMintModal(m => m ? { ...m, minting: true } : null)
    setBusy(true)
    try {
      let freshSqrtC = pos.sqrtPrice
      let freshTick  = pos.currentTick
      try {
        const [fSqrtP, fTk] = await contractCallTuple(pos.pool, 'get_slot0', [])
        freshSqrtC = BigInt(fSqrtP); freshTick = Number(fTk)
      } catch {}

      const Q96b = Q96
      let sqrtLChain = priceToSqrtPriceX96(tickToPrice(pos.tickLower))
      let sqrtUChain = priceToSqrtPriceX96(tickToPrice(pos.tickUpper))
      try {
        const sqrtLStr = await contractCallView<string>(pos.pool, 'get_sqrt_at_tick', [pos.tickLower])
        const sqrtUStr = await contractCallView<string>(pos.pool, 'get_sqrt_at_tick', [pos.tickUpper])
        sqrtLChain = BigInt(sqrtLStr); sqrtUChain = BigInt(sqrtUStr)
      } catch {}

      const sqrtC = freshSqrtC
      const tc    = freshTick
      const liq   = getLiquidityForAmounts(sqrtC, sqrtLChain, sqrtUChain, a0, a1)
      if (liq <= 0n) { addToast({ type: 'error', message: 'liquidity is zero, check amounts' }); return }

      const divUp = (a: bigint, b: bigint) => a % b === 0n ? a / b : a / b + 1n
      let poolAmt0 = 0n, poolAmt1 = 0n
      if (tc < pos.tickLower) {
        poolAmt0 = divUp(divUp(liq * Q96b * (sqrtUChain - sqrtLChain), sqrtUChain), sqrtLChain)
      } else if (tc < pos.tickUpper) {
        poolAmt0 = divUp(divUp(liq * Q96b * (sqrtUChain - sqrtC), sqrtUChain), sqrtC)
        poolAmt1 = divUp(liq * (sqrtC - sqrtLChain), Q96b)
      } else {
        poolAmt1 = divUp(liq * (sqrtUChain - sqrtLChain), Q96b)
      }

      const isNative0 = pos.token0 === CONTRACTS.woct
      if (isNative0 && poolAmt0 > 0n && BigInt(nativeBalance || '0') < poolAmt0) {
        addToast({ type: 'error', message: `insufficient OCT: need ${(Number(poolAmt0) / 1e6).toFixed(4)}, have ${(Number(nativeBalance || '0') / 1e6).toFixed(4)}` })
        return
      }
      if (poolAmt1 > 0n) {
        const freshBal1 = await contractCallView<string>(pos.token1, 'balance_of', [address]).catch(() => '0')
        if (BigInt(freshBal1 || '0') < poolAmt1) {
          addToast({ type: 'error', message: `insufficient ${sym1(pos)}: need ${(Number(poolAmt1) / 1e6).toFixed(4)}, have ${(Number(freshBal1 || '0') / 1e6).toFixed(4)}` })
          return
        }
      }

      type Step = { label: string; contract: string; method: string; params: (string | number | boolean)[]; value?: string; ou?: string }
      const steps: Step[] = []
      if (isNative0 && poolAmt0 > 0n) steps.push({ label: 'wrap OCT to WOCT', contract: CONTRACTS.woct, method: 'deposit', params: [], value: poolAmt0.toString() })
      if (poolAmt0 > 0n) steps.push({ label: `approve router for ${sym0(pos)}`, contract: pos.token0, method: 'grant', params: [CONTRACTS.router, poolAmt0.toString()] })
      if (poolAmt1 > 0n) steps.push({ label: `approve router for ${sym1(pos)}`, contract: pos.token1, method: 'grant', params: [CONTRACTS.router, poolAmt1.toString()] })
      steps.push({ label: 'add liquidity', contract: CONTRACTS.router, method: 'add_liquidity', params: [pos.pool, address, pos.tickLower, pos.tickUpper, liq.toString(), poolAmt0.toString(), poolAmt1.toString()], ou: '200000' })

      const pause = (ms: number) => new Promise<void>(res => setTimeout(res, ms))
      let lastHash = ''
      if (connectMethod === 'key') {
        const calls: MultiExecCall[] = steps.map(s => ({
          address: s.contract, method: s.method, params: s.params, amount: s.value ?? '0',
        }))
        const submit = async () => {
          const pin = await getSessionPin('Enter your wallet PIN to authorize adding liquidity')
          if (!pin) throw new Error('PIN required to add liquidity')
          return submitMultiExec(calls, '200000', pin)
        }
        try { lastHash = await submit() }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/\b403\b|PIN/i.test(msg)) { clearSessionPin(); lastHash = await submit() }
          else throw e
        }
        await pause(2000)
        let receipt = await getReceipt(lastHash)
        for (let t = 0; t < 29 && !receipt; t++) { await pause(2000); receipt = await getReceipt(lastHash) }
        if (receipt && !receipt.success) throw new Error(`add liquidity failed: ${receipt.error ?? 'reverted'}`)
        if (!receipt) throw new Error('add liquidity timed out')
      } else {
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]
          const r = await callContract(s.contract, s.method, s.params, s.value ?? '0', s.ou)
          lastHash = r.txHash
          await pause(2000)
          let receipt = await getReceipt(lastHash)
          for (let t = 0; t < 29 && !receipt; t++) { await pause(2000); receipt = await getReceipt(lastHash) }
          if (receipt && !receipt.success) throw new Error(`${s.label} failed: ${receipt.error ?? 'reverted'}`)
          if (!receipt) throw new Error(`${s.label} timed out`)
        }
      }

      saveLPHistory(address, {
        type: 'add', hash: lastHash, timestamp: Date.now(),
        sym0: sym0(pos), sym1: sym1(pos),
        amt0: (Number(poolAmt0) / 1e6).toFixed(4),
        amt1: (Number(poolAmt1) / 1e6).toFixed(4),
      })
      setMintModal(null)
      addToast({ type: 'success', message: 'liquidity added!', txHash: lastHash })
      await pause(1500)
      loadPositions()
    } catch (e: unknown) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'error' })
    } finally {
      setBusy(false)
      setMintModal(m => m ? { ...m, minting: false } : null)
    }
  }

  useEffect(() => {
    let alive = true
    getOctPrice()
      .then(async px => {
        if (!alive || !(px > 0)) return
        setOctPrice(px)
        const priceMap = await getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, px, CONTRACTS.router).catch(() => ({}))
        if (alive) setTokenPrices(priceMap)
      })
      .catch(() => {  })
    return () => { alive = false }
  }, [positions.length])

  const activeCount = positions.filter(p => p.inRange).length
  const fmt6    = (n: bigint) => (Number(n) / 1e6).toFixed(4)
  const fmtFee  = (n: bigint) => (Number(n) / 1e6).toFixed(6)

  function posUsdPrices(p: Position): [number, number] {
    if (octPrice <= 0) return [0, 0]
    const price = (t: string) => (t === CONTRACTS.woct ? octPrice : (tokenPrices[t] ?? 0))
    return [price(p.token0), price(p.token1)]
  }

  const totalValueUSD = positions.reduce((sum, p) => {
    const [p0, p1] = posUsdPrices(p)
    return sum + (Number(p.amount0) / 1e6) * p0 + (Number(p.amount1) / 1e6) * p1
  }, 0)

  const totalFeesUSD = positions.reduce((sum, p) => {
    const [p0, p1] = posUsdPrices(p)
    return sum + (Number(p.owed0) / 1e6) * p0 + (Number(p.owed1) / 1e6) * p1
  }, 0)
  const sym0  = (p: Position) => tokenSymbol(p.token0)
  const sym1  = (p: Position) => tokenSymbol(p.token1)

  const symUsd: Record<string, number> = {}
  for (const p of positions) {
    const [p0, p1] = posUsdPrices(p)
    if (p0 > 0) symUsd[sym0(p)] = p0
    if (p1 > 0) symUsd[sym1(p)] = p1
  }
  const lifetimeFeesUSD = Object.entries(collectedBySym).reduce((s, [sym, amt]) => s + amt * (symUsd[sym] ?? 0), 0)

  function RangeBar({ inR, pct0 }: { inR: boolean; pct0: number }) {
    if (!inR) {
      return (
        <div style={{ height: 8, borderRadius: 4, margin: '8px 0 10px', background: 'var(--oct-color-warning)', opacity: 0.7 }} />
      )
    }
    const left = Math.round(pct0 * 100)
    const right = 100 - left
    return (
      <div style={{ height: 8, borderRadius: 4, margin: '8px 0 10px', display: 'flex', overflow: 'hidden' }}>
        {left > 0 && <div style={{ flex: left, background: 'var(--oct-color-active)', borderRadius: right === 0 ? 4 : '4px 0 0 4px' }} />}
        {right > 0 && <div style={{ flex: right, background: 'var(--oct-color-border)', borderRadius: left === 0 ? 4 : '0 4px 4px 0' }} />}
      </div>
    )
  }

  function fmtUsd(v: number): string {
    if (v === 0) return '$0'
    if (v < 0.0001) return '<$0.0001'
    if (v < 0.01)   return '$' + v.toFixed(6)
    if (v < 1)      return '$' + v.toFixed(4)
    return '$' + v.toFixed(2)
  }

  return (
    <Page>

      <PageHead
        title="positions"
        actions={connected ? (
          <>
            {positions.some(x => x.owed0 > 0n || x.owed1 > 0n) && (
              <button
                onClick={collectAll}
                disabled={!!actionPending}
                className="ui-ghost"
                style={{
                  fontFamily: F, fontSize: 14, fontWeight: 600, height: 42, padding: '0 18px',
                  cursor: actionPending ? 'default' : 'pointer',
                  opacity: actionPending ? 0.5 : 1,
                }}
              >
                {actionPending === 'collect-all' ? 'collecting...' : 'claim all'}
              </button>
            )}
            <Link to="/pool" style={{
              fontFamily: F, fontSize: 14, fontWeight: 600,
              color: 'var(--oct-color-action-ink)', background: 'var(--oct-color-action)',
              display: 'inline-flex', alignItems: 'center', height: 42, padding: '0 22px',
              textDecoration: 'none', letterSpacing: 0, borderRadius: 'var(--r-md)',
              boxShadow: 'var(--sh-md)',
            }}>
              + add liquidity
            </Link>
          </>
        ) : undefined}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 40 }}>
        {(() => {
          const fmtStatUsd = (v: number) => v === 0 ? '$0.00' : v < 0.0001 ? '<$0.0001' : v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(2)
          const has = connected && positions.length > 0
          const cards: { label: string; value: string; sub?: string }[] = [
            { label: 'total value',  value: has ? '$' + totalValueUSD.toFixed(2) : '$0.00' },
            { label: 'fees earned',  value: has ? fmtStatUsd(lifetimeFeesUSD) : '$0.00', sub: 'unclaimed ' + (connected ? fmtStatUsd(totalFeesUSD) : '$0.00') },
            { label: 'active positions',
              value: connected ? (positions.length > activeCount ? `${activeCount} of ${positions.length}` : String(activeCount)) : 'n/a',
              sub: connected && positions.length > activeCount ? `${positions.length - activeCount} out of range` : undefined },
          ]
          return cards.map(c => (
            <div key={c.label} style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '24px 28px' }}>
              <div style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 12 }}>{c.label}</div>
              <div style={{ fontFamily: M, fontSize: 28, color: 'var(--oct-color-text)', letterSpacing: '-0.5px' }}>{c.value}</div>
              {c.sub && <div style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 6 }}>{c.sub}</div>}
            </div>
          ))
        })()}
      </div>

      {connected && pts && (
        <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '24px 28px', marginBottom: 40 }}>
          <div onClick={togglePts} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: ptsOpen ? 20 : 0, cursor: 'pointer', userSelect: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: M, fontSize: 11, color: 'var(--oct-color-muted)', transform: ptsOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block', alignSelf: 'center' }}>▶</span>
              <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', textTransform: 'uppercase' }}>FACT points</div>
              <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-muted)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>season 0</div>
              {!ptsOpen && <div style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)' }}>{pts.total.toLocaleString()} pts</div>}
            </div>
            <Link to="/leaderboard" onClick={e => e.stopPropagation()} style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-primary)', textDecoration: 'none' }}>view leaderboard</Link>
          </div>
          {ptsOpen && (<>
          <div className="pts-head" style={{ display: 'grid', gap: 16 }}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 8 }}>points</div>
              <div style={{ fontFamily: M, fontSize: 34, color: 'var(--oct-color-text)', letterSpacing: '-0.5px' }}>{pts.total.toLocaleString()}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 8 }}>daily streak</div>
              <div style={{ fontFamily: M, fontSize: 26, color: 'var(--oct-color-text)' }}>{pts.streak} day{pts.streak === 1 ? '' : 's'}</div>
              <div style={{ fontFamily: M, fontSize: 15, color: 'var(--oct-color-primary)', marginTop: 4 }}>×{pts.streakMult.toFixed(2)} boost</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 8 }}>tier</div>
              <div style={{ fontFamily: M, fontSize: 26, color: 'var(--oct-color-text)', textTransform: 'capitalize' }}>{pts.tier}</div>
              <div style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-muted)', marginTop: 4 }}>+{Math.round(pts.tierMult * 100)}% bonus</div>
            </div>
          </div>
          <div className="pts-bd" style={{ display: 'grid', gap: 12, marginTop: 18 }}>
            {([
              ['liquidity', pts.breakdown.liquidity],
              ['public swaps', pts.breakdown.publicSwaps],
              ['relayer', pts.breakdown.relayer],
              ['referrals', pts.breakdown.referrals],
            ] as [string, number][]).map(([k, v], i, arr) => {
              const align = i === 0 ? 'left' : i === arr.length - 1 ? 'right' : 'center'
              return (
                <div key={k} style={{ textAlign: align as 'left' | 'center' | 'right' }}>
                  <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{k}</div>
                  <div style={{ fontFamily: M, fontSize: 16, color: 'var(--oct-color-text)', marginTop: 4 }}>{v.toLocaleString()}</div>
                </div>
              )
            })}
          </div>
          <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-faint)', marginTop: 16 }}>
            streak grows 3% per consecutive active day and resets if you skip a day. points are provisional until the season ends.
          </div>
          </>)}
        </div>
      )}

      {!connected ? (
        <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '80px 20px', textAlign: 'center' }}>
          <div style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)', marginBottom: 24 }}>
            connect your wallet to see your positions
          </div>
          <button onClick={openConnectModal} style={{
            fontFamily: F, fontSize: 14, fontWeight: 600,
            color: 'var(--oct-color-action-ink)', background: 'var(--oct-color-action)',
            border: 'none', padding: '12px 32px', cursor: 'pointer',
          }}>
            connect wallet
          </button>
        </div>
      ) : loading ? (
        <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '80px 20px', textAlign: 'center', fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)' }}>
          loading positions...
        </div>
      ) : positions.length === 0 ? (
        <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '80px 20px', textAlign: 'center' }}>
          <div style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)', marginBottom: 24 }}>
            no positions yet. add liquidity to get started.
          </div>
          <Link to="/pool" style={{
            fontFamily: F, fontSize: 14, fontWeight: 600,
            color: 'var(--oct-color-action-ink)', background: 'var(--oct-color-action)',
            padding: '12px 32px', textDecoration: 'none',
          }}>
            add liquidity
          </Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))', gap: 20 }}>
          {positions.map(p => {
            const hasFees      = p.owed0 > 0n || p.owed1 > 0n
            const s0 = sym0(p), s1 = sym1(p)
            const busy = !!actionPending
            const burnKey = `burn-${p.pool}-${p.tickLower}-${p.tickUpper}`
            const collectKey = `collect-${p.pool}-${p.tickLower}-${p.tickUpper}`
            const isBurning    = actionPending === burnKey
            const isCollecting = actionPending === collectKey

            const [p0usd, p1usd] = posUsdPrices(p)
            const usd0     = (Number(p.amount0) / 1e6) * p0usd
            const usd1     = (Number(p.amount1) / 1e6) * p1usd
            const posValue = usd0 + usd1
            const fees0usd = (Number(p.owed0) / 1e6) * p0usd
            const fees1usd = (Number(p.owed1) / 1e6) * p1usd
            const feesUsdVal = fees0usd + fees1usd
            const totalUsd = posValue + feesUsdVal

            const pct0 = totalUsd > 0 ? usd0 / posValue : 0.5

            const apr = !p.inRange ? 0
              : (p.poolActiveLiq > 0n && posValue >= 1 && p.poolFees24hUsd > 0)
                ? Math.min((p.poolFees24hUsd * (Number(p.liquidity) / Number(p.poolActiveLiq)) * 365 / posValue) * 100, 100_000)
                : p.poolApr

            const currentPrice = formatNumber(sqrtPriceToPrice(p.sqrtPrice, 6, 6), 4)

            return (
              <div key={`${p.pool}-${p.tickLower}-${p.tickUpper}`} style={{
                background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)',
                display: 'flex', flexDirection: 'column',
              }}>

                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '16px 18px 10px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 9, rowGap: 4, minWidth: 0 }}>
                    <div style={{ fontFamily: F, fontSize: 16, color: 'var(--oct-color-text)' }}>{s0}/{s1}</div>
                    <span style={{ fontFamily: F, fontSize: 12.5, color: 'var(--oct-color-muted)', whiteSpace: 'nowrap' }}>
                      {feeToPercent(p.fee)} fee
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => openMintModal(p)}
                      disabled={busy}
                      aria-label="add liquidity"
                      style={{
                        width: 30, height: 30, borderRadius: 'var(--r-sm)',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: 0, border: 'none',
                        color: busy ? 'var(--oct-color-faint)' : 'var(--oct-color-primary-deep)',
                        background: busy ? 'var(--oct-color-surface-soft)' : 'var(--oct-color-primary-soft)',
                        cursor: busy ? 'default' : 'pointer',
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                           strokeWidth="1.9" strokeLinecap="round" style={{ display: 'block' }}>
                        <path d="M7 1.6v10.8M1.6 7h10.8" />
                      </svg>
                    </button>
                    <button
                      onClick={() => { if (!busy && p.liquidity > 0n) setBurnModal({ pos: p, pct: 100 }) }}
                      disabled={busy || p.liquidity === 0n}
                      aria-label="remove liquidity"
                      style={{
                        width: 30, height: 30, borderRadius: 'var(--r-sm)',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: 0, border: 'none',
                        color: busy || p.liquidity === 0n ? 'var(--oct-color-faint)' : 'var(--oct-color-danger)',
                        background: busy || p.liquidity === 0n ? 'var(--oct-color-surface-soft)' : 'var(--oct-color-danger-soft)',
                        cursor: busy || p.liquidity === 0n ? 'default' : 'pointer',
                      }}
                    >
                      {isBurning ? (
                        <svg className="oct-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.6" opacity=".3" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                             strokeWidth="1.9" strokeLinecap="round" style={{ display: 'block' }}>
                          <path d="M1.6 7h10.8" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div style={{ padding: '2px 18px 12px', textAlign: 'center' }}>
                  <span style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '1px' }}>apr </span>
                  <span style={{ fontFamily: F, fontSize: 18, color: apr > 0 ? 'var(--oct-color-success)' : 'var(--oct-color-text)' }}>
                    {apr > 0 ? apr.toFixed(2) + '%' : '0%'}
                  </span>
                </div>

                <div style={{ padding: '4px 18px 18px', textAlign: 'center' }}>
                  <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '1px', marginBottom: 8 }}>
                    unclaimed fees
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontFamily: F, fontSize: 28, lineHeight: 1.1, color: hasFees ? 'var(--oct-color-text)' : 'var(--oct-color-faint)' }}>
                      {!hasFees ? fmtUsd(0) : octPrice > 0 ? fmtUsd(feesUsdVal) : 'n/a'}
                    </div>
                    <div style={{ fontFamily: M, fontSize: 11, color: 'var(--oct-color-faint)', marginTop: 5 }}>
                      {fmtFee(p.owed0)} {s0} + {fmtFee(p.owed1)} {s1}
                    </div>
                  </div>
                  <button
                    onClick={() => collectFees(p)}
                    disabled={busy || !hasFees}
                    style={{
                      width: '100%', padding: '13px', border: 'none',
                      borderRadius: 'var(--r-md)',
                      background: !hasFees || busy ? 'var(--oct-color-surface)' : 'var(--oct-color-action)',
                      color: !hasFees || busy ? 'var(--oct-color-faint)' : 'var(--oct-color-action-ink)',
                      fontFamily: F, fontSize: 14,
                      letterSpacing: '0.3px', cursor: !hasFees || busy ? 'default' : 'pointer',
                    }}
                  >
                    {isCollecting ? 'collecting...' : 'claim'}
                  </button>
                </div>

                <div style={{ padding: '0 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>
                      position:{' '}
                      <span style={{ fontFamily: F, color: 'var(--oct-color-text)' }}>
                        {fmtUsd(posValue)}
                      </span>
                    </div>
                    <div style={{ fontFamily: M, fontSize: 11, color: 'var(--oct-color-faint)', marginTop: 5 }}>
                      {fmt6(p.amount0)} {s0} + {fmt6(p.amount1)} {s1}
                    </div>
                  </div>
                  {posValue > 0 && (
                    <div style={{
                      fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)',
                      flexShrink: 0, marginLeft: 12, textAlign: 'right', whiteSpace: 'nowrap',
                    }}>
                      <span style={{ color: 'var(--oct-color-text-2)' }}>{Math.round(pct0 * 100)}%</span> {s0}
                      <span style={{ display: 'inline-block', width: 10 }} />
                      <span style={{ color: 'var(--oct-color-text-2)' }}>{Math.round((1 - pct0) * 100)}%</span> {s1}
                    </div>
                  )}
                </div>

                <div style={{ padding: '12px 18px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)' }}>
                    price{' '}
                    <span style={{ fontFamily: F, color: 'var(--oct-color-text)' }}>{currentPrice}</span>
                    {' '}{s1} per {s0}
                  </span>
                  <span style={{
                    fontFamily: F, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                    color: p.inRange ? 'var(--oct-color-success)' : 'var(--oct-color-warning)',
                  }}>
                    {p.inRange ? 'in range' : 'out of range'}
                  </span>
                </div>

                <div style={{ padding: '4px 18px 20px' }}>
                  <RangeBar inR={p.inRange} pct0={pct0} />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-faint)' }}>min</div>
                      <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-text)' }}>{formatNumber(tickToPrice(p.tickLower), 4)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-faint)' }}>max</div>
                      <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-text)' }}>{formatNumber(tickToPrice(p.tickUpper), 4)}</div>
                    </div>
                  </div>
                </div>

              </div>
            )
          })}
        </div>
      )}

      {burnModal && (() => {
        const { pos, pct } = burnModal
        const s0m = sym0(pos), s1m = sym1(pos)
        const preview0 = pct >= 100 ? pos.amount0 : pos.amount0 * BigInt(pct) / 100n
        const preview1 = pct >= 100 ? pos.amount1 : pos.amount1 * BigInt(pct) / 100n
        const [p0, p1] = posUsdPrices(pos)
        const previewUSD = (Number(preview0) / 1e6) * p0 + (Number(preview1) / 1e6) * p1
        return (
          <div
            onClick={() => setBurnModal(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)',
                padding: '28px 32px', width: 400, maxWidth: '90vw',
              }}
            >
              <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
                remove liquidity
              </div>
              <div style={{ fontFamily: F, fontSize: 20, fontWeight: 700, color: 'var(--oct-color-text)', marginBottom: 24 }}>
                {s0m} / {s1m} &nbsp;
                <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-muted)', fontWeight: 400 }}>{feeToPercent(pos.fee)}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                  amount to remove
                </div>
                <div style={{ fontFamily: M, fontSize: 26, fontWeight: 700, color: 'var(--oct-color-text)' }}>
                  {pct}%
                </div>
              </div>
              <input
                type="range" min={1} max={100} value={pct}
                onChange={e => setBurnModal({ pos, pct: Number(e.target.value) })}
                style={{ width: '100%', accentColor: 'var(--oct-color-primary)', marginBottom: 24, cursor: 'pointer' }}
              />

              <div style={{ background: 'var(--oct-color-surface)', borderRadius: 'var(--r-md)', padding: '14px 18px', marginBottom: 24 }}>
                <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                  you will receive approximately
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: M, fontSize: 15, color: 'var(--oct-color-text)' }}>{s0m}</span>
                  <span style={{ fontFamily: M, fontSize: 15, color: 'var(--oct-color-text)' }}>{fmt6(preview0)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontFamily: M, fontSize: 15, color: 'var(--oct-color-text)' }}>{s1m}</span>
                  <span style={{ fontFamily: M, fontSize: 15, color: 'var(--oct-color-text)' }}>{fmt6(preview1)}</span>
                </div>
                {previewUSD > 0 && (
                  <div style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-muted)', textAlign: 'right' }}>
                    ≈ ${previewUSD.toFixed(2)}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setBurnModal(null)}
                  style={{
                    flex: 1, padding: '12px',
                    fontFamily: F, fontSize: 14, fontWeight: 600,
                    color: 'var(--oct-color-primary)', background: 'transparent',
                    border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                  }}
                >
                  cancel
                </button>
                <button
                  onClick={() => { setBurnModal(null); removeLiquidity(pos, pct) }}
                  style={{
                    flex: 2, padding: '12px',
                    fontFamily: F, fontSize: 14, fontWeight: 600,
                    color: '#ffffff', background: 'var(--oct-color-danger)',
                    border: 'none', cursor: 'pointer',
                  }}
                >
                  remove {pct >= 100 ? '100%' : `${pct}%`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
      {mintModal && (() => {
        const { pos, input0, input1, bal0, bal1, minting } = mintModal
        const s0m = sym0(pos), s1m = sym1(pos)
        const [p0, p1] = posUsdPrices(pos)
        const usd0 = Number(input0) > 0 ? (Number(input0) * p0).toFixed(2) : null
        const usd1 = Number(input1) > 0 ? (Number(input1) * p1).toFixed(2) : null
        const totalUsd = (Number(usd0) || 0) + (Number(usd1) || 0)

        const sqrtL = priceToSqrtPriceX96(tickToPrice(pos.tickLower))
        const sqrtU = priceToSqrtPriceX96(tickToPrice(pos.tickUpper))
        const onlyToken0 = pos.sqrtPrice >= sqrtU
        const onlyToken1 = pos.sqrtPrice <= sqrtL

        const posUsd0 = (Number(pos.amount0) / 1e6) * p0
        const posUsd1 = (Number(pos.amount1) / 1e6) * p1
        const posTotalUsd = posUsd0 + posUsd1
        const pct0 = posTotalUsd > 0 ? posUsd0 / posTotalUsd : 0.5

        const canAdd = (Number(input0) > 0 || Number(input1) > 0) && !minting
        return (
          <div
            onClick={() => !minting && setMintModal(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          >
            <div onClick={e => e.stopPropagation()} style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: '28px 32px', width: 420, maxWidth: '90vw' }}>
              <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
                add liquidity
              </div>
              <div style={{ fontFamily: F, fontSize: 20, fontWeight: 700, color: 'var(--oct-color-text)', marginBottom: 12 }}>
                {s0m} / {s1m} &nbsp;
                <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-muted)', fontWeight: 400 }}>{feeToPercent(pos.fee)}</span>
              </div>

              <div style={{ display: 'flex', gap: 14, marginBottom: 20, fontFamily: F, fontSize: 12.5, color: 'var(--oct-color-muted)' }}>
                <span>
                  <span style={{ color: 'var(--oct-color-text-2)' }}>{Math.round(pct0 * 100)}%</span> {s0m}
                  <span style={{ display: 'inline-block', width: 10 }} />
                  <span style={{ color: 'var(--oct-color-text-2)' }}>{Math.round((1 - pct0) * 100)}%</span> {s1m}
                </span>
                {!pos.inRange && (
                  <span style={{ fontWeight: 600, color: 'var(--oct-color-warning)' }}>out of range</span>
                )}
              </div>

              <div style={{ background: 'var(--oct-color-surface)', borderRadius: 'var(--r-md)', padding: '14px 16px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 600 }}>{s0m}</span>
                  <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', cursor: 'pointer' }}
                    onClick={() => !onlyToken0 && !minting && mintInput0Change((Number(bal0) / 1e6).toFixed(6), pos)}
                  >
                    bal: {(Number(bal0) / 1e6).toFixed(4)}
                  </span>
                </div>
                <input
                  type="number" min="0" placeholder="0.000000"
                  value={input0}
                  disabled={onlyToken0 || minting}
                  onChange={e => mintInput0Change(e.target.value, pos)}
                  style={{
                    width: '100%', background: 'transparent', border: 'none', outline: 'none',
                    fontFamily: M, fontSize: 22, color: onlyToken0 ? 'var(--oct-color-faint)' : 'var(--oct-color-text)',
                    padding: 0, boxSizing: 'border-box',
                  }}
                />
                {usd0 && p0 > 0 && (
                  <div style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 4 }}>${usd0}</div>
                )}
              </div>

              <div style={{ background: 'var(--oct-color-surface)', borderRadius: 'var(--r-md)', padding: '14px 16px', marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 600 }}>{s1m}</span>
                  <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', cursor: 'pointer' }}
                    onClick={() => !onlyToken1 && !minting && mintInput1Change((Number(bal1) / 1e6).toFixed(6), pos)}
                  >
                    bal: {(Number(bal1) / 1e6).toFixed(4)}
                  </span>
                </div>
                <input
                  type="number" min="0" placeholder="0.000000"
                  value={input1}
                  disabled={onlyToken1 || minting}
                  onChange={e => mintInput1Change(e.target.value, pos)}
                  style={{
                    width: '100%', background: 'transparent', border: 'none', outline: 'none',
                    fontFamily: M, fontSize: 22, color: onlyToken1 ? 'var(--oct-color-faint)' : 'var(--oct-color-text)',
                    padding: 0, boxSizing: 'border-box',
                  }}
                />
                {usd1 && p1 > 0 && (
                  <div style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 4 }}>${usd1}</div>
                )}
              </div>

              {totalUsd > 0 && (
                <div style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-muted)', textAlign: 'right', marginBottom: 20 }}>
                  total ≈ ${totalUsd.toFixed(2)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => !minting && setMintModal(null)}
                  style={{ flex: 1, padding: '12px', fontFamily: F, fontSize: 14, fontWeight: 600, color: 'var(--oct-color-text-2)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', cursor: 'pointer' }}
                >cancel</button>
                <button
                  onClick={() => addLiquidityToPosition(pos, input0, input1)}
                  disabled={!canAdd}
                  style={{ flex: 2, padding: '12px', fontFamily: F, fontSize: 14, fontWeight: 600, color: canAdd ? 'var(--oct-color-action-ink)' : 'var(--oct-color-faint)', background: canAdd ? 'var(--oct-color-action)' : 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', cursor: canAdd ? 'pointer' : 'default' }}
                >{minting ? 'adding...' : 'add liquidity'}</button>
              </div>
            </div>
          </div>
        )
      })()}
    </Page>
  )
}
