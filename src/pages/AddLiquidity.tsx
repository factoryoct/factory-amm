import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import PageHead, { Page } from '../components/PageHead'
import { useParams, useNavigate } from 'react-router-dom'
import { useWallet, CONTRACTS } from '../context/WalletContext'
import { contractCall, contractCallView, contractCallTuple, getOctPrice, getReceipt, submitMultiExec, type MultiExecCall, lastOctPrice } from '../utils/rpc'
import {
  tickToPrice, nearestUsableTick, priceToTick, sqrtPriceToPrice, Q96,
  getLiquidityForAmounts, getAmount0, getAmount1,
} from '../utils/math'
import {
  ComposedChart, Area, XAxis, ReferenceLine, ReferenceArea, ResponsiveContainer,
} from 'recharts'
import Segmented from '../components/Segmented'
import { FEE_RESERVE, spendableNative, formatBaseUnits } from '../utils/gas'
import { tokenSymbol, getToken } from '../config/tokens'
import { toBaseUnits } from '../utils/format'
import { estimate, windowByHours, deviationPercent, ALARM, type Estimate } from '../utils/oracle'
import { formatCompact, formatNumber } from '../utils/format'
import { getPoolMetrics, recordPoolPrice, fetchPoolPrices, type PoolMetrics } from '../utils/poolMetrics'
import { useIsMobile } from '../hooks/useMediaQuery'

interface PoolInfo {
  token0: string; token1: string; sym0: string; sym1: string
  fee: number; tickSpacing: number; sqrtPrice: bigint; currentTick: number
}
interface BarDatum { tick: number; price: number; liq: number }

async function loadRealDepth(pool: string, currentTick: number, tickSpacing: number): Promise<BarDatum[]> {
  const compressed = Math.floor(currentTick / tickSpacing)
  const centerWord = Math.floor(compressed / 256)
  const ticks: { tick: number; liquidityNet: number }[] = []

  const wordNums: number[] = []
  for (let w = centerWord - 2; w <= centerWord + 2; w++) wordNums.push(w)
  const words = await Promise.all(wordNums.map(w =>
    contractCall<string>(pool, 'get_bitmap_word', [String(w)]).catch(() => '0')))

  const wanted: number[] = []
  words.forEach((raw, i) => {
    let wordVal: bigint
    try { wordVal = BigInt(raw || '0') } catch { return }
    if (wordVal === 0n) return
    for (let bit = 0; bit < 256; bit++) {
      if ((wordVal >> BigInt(bit)) & 1n) wanted.push((wordNums[i] * 256 + bit) * tickSpacing)
    }
  })

  const nets = await Promise.all(wanted.map(t =>
    contractCallTuple(pool, 'get_tick_data', [String(t)]).then(r => r[1]).catch(() => null)))
  wanted.forEach((tick, i) => {
    if (nets[i] !== null) ticks.push({ tick, liquidityNet: Number(nets[i]) })
  })

  if (ticks.length === 0) return []
  ticks.sort((a, b) => a.tick - b.tick)

  const minTick = ticks[0].tick - tickSpacing * 4
  const maxTick = ticks[ticks.length - 1].tick + tickSpacing * 4
  const bars: BarDatum[] = []

  let cumLiq = 0
  let ti = 0
  for (let t = minTick; t <= maxTick; t += tickSpacing) {
    while (ti < ticks.length && ticks[ti].tick <= t) {
      cumLiq += ticks[ti].liquidityNet
      ti++
    }
    bars.push({ tick: t, price: tickToPrice(t), liq: Math.max(0, cumLiq) })
  }

  const maxLiq = Math.max(...bars.map(b => b.liq), 1)
  return bars.map(b => ({ ...b, liq: b.liq / maxLiq }))
}

function calcOctFraction(cur: number, lo: number, hi: number): number {
  if (cur <= lo) return 1
  if (cur >= hi) return 0
  return (hi - cur) / (hi - lo)
}

function pct(price: number, current: number): string {
  const p = (price - current) / current * 100
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'
}

const CHART_H = 300
const M_TOP   = 40
const M_RIGHT = 4
const M_BOT   = 32
const AXIS_W  = 64
const PLOT_H  = CHART_H - M_TOP - M_BOT

export default function AddLiquidity() {
  const { poolAddress } = useParams<{ poolAddress: string }>()
  const navigate = useNavigate()
  const baseUnits = (v: string) => { try { return BigInt(v || '0') } catch { return 0n } }
  const spendable0 = () =>
    poolInfo && poolInfo.token0 === CONTRACTS.woct
      ? spendableNative(baseUnits(bal0))
      : baseUnits(bal0)

  const { address, balance: nativeBalance, connected, connectMethod, addToast, callContract, openConnectModal, refreshBalance, setBusy, getSessionPin, clearSessionPin } = useWallet()

  const [poolInfo,   setPoolInfo]   = useState<PoolInfo | null>(null)
  const [oracle, setOracle] = useState<Estimate | null>(null)
  const [tickLower,  setTickLower]  = useState(-600)
  const [tickUpper,  setTickUpper]  = useState(600)
  const [amount0,    setAmount0]    = useState('')
  const [amount1,    setAmount1]    = useState('')
  const [bal0,       setBal0]       = useState('0')
  const [bal1,       setBal1]       = useState('0')
  const [loading,    setLoading]    = useState(false)
  const [loadError,  setLoadError]  = useState(false)
  const [bars,       setBars]       = useState<BarDatum[]>([])
  const [dragging,   setDragging]   = useState<'lower' | 'upper' | null>(null)
  const [rangeView,  setRangeView]  = useState<'liquidity' | 'price'>('liquidity')
  const [frame, setFrame] = useState<'1h' | '6h' | '1d' | '1w' | 'all'>('1d')
  const [zoom, setZoom] = useState(1)
  const [panPx, setPanPx] = useState(0)
  const [vShift, setVShift] = useState(0)
  const [vZoom,  setVZoom]  = useState(1)
  const [panning, setPanning] = useState<
    { x: number; y: number; pan: number; vs: number; vz: number; mode: 'chart' | 'scale' } | null
  >(null)
  useEffect(() => { setPanPx(0); setZoom(1); setVShift(0); setVZoom(1) }, [frame])
  const viewSpan = rangeView === 'price' ? 2000 : 4000
  const [octPrice,   setOctPrice]   = useState(lastOctPrice)
  const [chartWidth, setChartWidth] = useState(0)
  const isMobile = useIsMobile()
  const [minPriceEdit, setMinPriceEdit] = useState<string | null>(null)
  const [maxPriceEdit, setMaxPriceEdit] = useState<string | null>(null)
  const [metrics,    setMetrics]    = useState<PoolMetrics | null>(null)
  const [priceHistory, setPriceHistory] = useState<{ epoch: number; price: number }[]>([])

  const chartRef    = useRef<HTMLDivElement>(null)
  const snap        = useRef({ tickLower, tickUpper, poolInfo, dragging, bars, rangeView, viewSpan })
  snap.current      = { tickLower, tickUpper, poolInfo, dragging, bars, rangeView, viewSpan }
  const fracRef     = useRef<(f: number) => number>(f => f)
  const lastEdited  = useRef<'amount0' | 'amount1' | null>(null)
  const amountsRef  = useRef({ amount0, amount1 })
  amountsRef.current = { amount0, amount1 }

  useEffect(() => { getOctPrice().then(setOctPrice).catch(() => {}) }, [])
  useEffect(() => { if (poolAddress) loadPool() }, [poolAddress])

  useLayoutEffect(() => {
    const measure = () => {
      if (chartRef.current) {
        const w = chartRef.current.clientWidth
        if (w > 0) setChartWidth(w)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })

  useEffect(() => {
    if (!connected || !address || !poolInfo) return
    if (poolInfo.token0 === CONTRACTS.woct) {
      setBal0(nativeBalance)
      contractCallView<string>(poolInfo.token1, 'balance_of', [address])
        .then(bal => setBal1(bal ?? '0'))
        .catch(() => setBal1('0'))
    } else {
      Promise.all([
        contractCallView<string>(poolInfo.token0, 'balance_of', [address]),
        contractCallView<string>(poolInfo.token1, 'balance_of', [address]),
      ])
        .then(([b0, b1]) => { setBal0(b0 ?? '0'); setBal1(b1 ?? '0') })
        .catch(() => { setBal0('0'); setBal1('0') })
    }
  }, [connected, address, poolInfo, nativeBalance])

  async function loadPool() {
    if (!poolAddress) return
    setLoadError(false)
    try {
      const [t0, t1]    = await contractCallTuple(poolAddress, 'get_tokens', [])
      const [fee, ts]   = await contractCallTuple(poolAddress, 'get_config', [])
      const [sqrtP, tk] = await contractCallTuple(poolAddress, 'get_slot0', [])
      const spacing = Number(ts)
      const sqrtPBig = BigInt(sqrtP)
      const realPrice = sqrtPriceToPrice(sqrtPBig, 6, 6)
      const derivedTick = realPrice > 0 ? priceToTick(realPrice) : Number(tk)
      const initLower = nearestUsableTick(priceToTick(realPrice * 0.95), spacing)
      const initUpper = nearestUsableTick(priceToTick(realPrice * 1.05), spacing)
      setPoolInfo({
        token0: t0, token1: t1,
        sym0: tokenSymbol(t0),
        sym1: tokenSymbol(t1),
        fee: Number(fee), tickSpacing: spacing,
        sqrtPrice: sqrtPBig, currentTick: derivedTick,
      })
      setTickLower(initLower)
      setTickUpper(initUpper)
      setPriceHistory(recordPoolPrice(poolAddress, realPrice))
      void fetchPoolPrices(poolAddress).then(rows => {
        if (rows.length > 1) setPriceHistory(rows)
      })
      getPoolMetrics(poolAddress, t0, t1, sqrtP, Number(fee)).then(setMetrics).catch(() => {})
      void estimate(t0, t1, windowByHours(1)).then(setOracle).catch(() => setOracle(null))
      loadRealDepth(poolAddress, derivedTick, spacing).then(realBars => {
        setBars(realBars.length > 0 ? realBars : [])
      }).catch(() => {})
    } catch (e) {
      console.error('[AddLiquidity] loadPool:', e)
      setLoadError(true)
    }
  }

  function tickToPct(tick: number): number {
    const ct   = poolInfo?.currentTick ?? 0
    const frac = (tick - (ct - 4000)) / 8000
    const w    = chartWidth > 0 ? (chartWidth - M_RIGHT) / chartWidth : 1
    return Math.max(0, Math.min(100, frac * w * 100))
  }

  useEffect(() => {
    if (!panning) return
    const slot = Math.max(3, Math.min(40, 11 * zoom))
    void slot
    const move = (e: MouseEvent) => {
      const dy = e.clientY - panning.y
      if (panning.mode === 'scale') {
        setVZoom(Math.max(0.15, Math.min(8, panning.vz * Math.exp((dy / PLOT_H) * 1.6))))
        return
      }
      setPanPx(panning.pan - (e.clientX - panning.x))
      setVShift(panning.vs + dy / PLOT_H)
    }
    const up = () => setPanning(null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [panning, zoom])

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const { dragging, poolInfo, tickLower, tickUpper, rangeView, viewSpan } = snap.current
      if (!dragging || !chartRef.current || !poolInfo) return
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX
      const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY
      if (clientX == null || clientY == null) return
      if ('touches' in e) e.preventDefault()
      const rect = chartRef.current.getBoundingClientRect()
      let raw: number
      if (rangeView === 'price') {
        const frac = Math.max(0, Math.min(1, 1 - (clientY - rect.top - M_TOP) / PLOT_H))
        raw = priceToTick(fracRef.current(frac))
      } else {
        const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width - M_RIGHT)))
        const minT = poolInfo.currentTick - viewSpan
        const maxT = poolInfo.currentTick + viewSpan
        raw = Math.round(minT + pct * (maxT - minT))
      }
      const tick = nearestUsableTick(raw, poolInfo.tickSpacing)
      if (dragging === 'lower') setTickLower(Math.min(tick, tickUpper - poolInfo.tickSpacing))
      else                      setTickUpper(Math.max(tick, tickLower + poolInfo.tickSpacing))
    }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend',  onUp)
    window.addEventListener('touchcancel', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
    }
  }, [])

  const onAmount0Change = useCallback((val: string) => {
    lastEdited.current = 'amount0'
    setAmount0(val)
    if (!poolInfo || !val || isNaN(Number(val))) { setAmount1(''); return }
    const sqrtL = BigInt(Math.floor(Math.sqrt(tickToPrice(tickLower)) * Number(Q96)))
    const sqrtU = BigInt(Math.floor(Math.sqrt(tickToPrice(tickUpper)) * Number(Q96)))
    const sqrtC = poolInfo.sqrtPrice
    const liq   = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, BigInt(Math.round(Number(val) * 1e6)), 0n)
    const a1    = sqrtC <= sqrtL ? 0n : getAmount1(sqrtL, sqrtC > sqrtU ? sqrtU : sqrtC, liq)
    setAmount1((Number(a1) / 1e6).toFixed(6))
  }, [poolInfo, tickLower, tickUpper])

  const onAmount1Change = useCallback((val: string) => {
    lastEdited.current = 'amount1'
    setAmount1(val)
    if (!poolInfo || !val || isNaN(Number(val))) { setAmount0(''); return }
    const sqrtL = BigInt(Math.floor(Math.sqrt(tickToPrice(tickLower)) * Number(Q96)))
    const sqrtU = BigInt(Math.floor(Math.sqrt(tickToPrice(tickUpper)) * Number(Q96)))
    const sqrtC = poolInfo.sqrtPrice
    const liq   = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, 0n, BigInt(Math.round(Number(val) * 1e6)))
    const a0    = getAmount0(sqrtC, sqrtU < sqrtC ? sqrtC : sqrtU, liq)
    setAmount0((Number(a0) / 1e6).toFixed(6))
  }, [poolInfo, tickLower, tickUpper])

  useEffect(() => {
    if (!poolInfo || !lastEdited.current) return
    const sqrtL = BigInt(Math.floor(Math.sqrt(tickToPrice(tickLower)) * Number(Q96)))
    const sqrtU = BigInt(Math.floor(Math.sqrt(tickToPrice(tickUpper)) * Number(Q96)))
    const sqrtC = poolInfo.sqrtPrice
    const { amount0: a0str, amount1: a1str } = amountsRef.current
    if (lastEdited.current === 'amount0') {
      if (!a0str || isNaN(Number(a0str))) return
      const liq = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, BigInt(Math.round(Number(a0str) * 1e6)), 0n)
      const a1  = sqrtC <= sqrtL ? 0n : getAmount1(sqrtL, sqrtC > sqrtU ? sqrtU : sqrtC, liq)
      setAmount1((Number(a1) / 1e6).toFixed(6))
    } else {
      if (!a1str || isNaN(Number(a1str))) return
      const liq = getLiquidityForAmounts(sqrtC, sqrtL, sqrtU, 0n, BigInt(Math.round(Number(a1str) * 1e6)))
      const a0  = getAmount0(sqrtC, sqrtU < sqrtC ? sqrtC : sqrtU, liq)
      setAmount0((Number(a0) / 1e6).toFixed(6))
    }
  }, [tickLower, tickUpper, poolInfo])

  const doAdd = async () => {
    if (!connected) { openConnectModal(); return }
    if (!poolAddress || !poolInfo) return

    for (const addr of [poolInfo.token0, poolInfo.token1]) {
      const tk = getToken(addr)
      if (tk && tk.decimals !== 6) {
        addToast({ type: 'error', message:
          `${tk.symbol} has ${tk.decimals} decimals; liquidity currently supports 6-decimal tokens only` })
        return
      }
    }

    const a0 = toBaseUnits(amount0, 6)
    const a1 = toBaseUnits(amount1, 6)
    if (a0 <= 0n && a1 <= 0n) return

    let freshSqrtC = poolInfo.sqrtPrice
    let freshTick  = poolInfo.currentTick
    try {
      const [fSqrtP, fTk] = await contractCallTuple(poolAddress, 'get_slot0', [])
      freshSqrtC = BigInt(fSqrtP)
      freshTick  = Number(fTk)
    } catch (e) { console.warn('[diag] fresh slot0 failed, using cached:', e) }

    const Q96b = BigInt('79228162514264337593543950336')
    let sqrtLChain = BigInt(Math.floor(Math.sqrt(tickToPrice(tickLower)) * Number(Q96)))
    let sqrtUChain = BigInt(Math.floor(Math.sqrt(tickToPrice(tickUpper)) * Number(Q96)))
    try {
      const sqrtLStr = await contractCallView<string>(poolAddress, 'get_sqrt_at_tick', [tickLower])
      const sqrtUStr = await contractCallView<string>(poolAddress, 'get_sqrt_at_tick', [tickUpper])
      sqrtLChain = BigInt(sqrtLStr)
      sqrtUChain = BigInt(sqrtUStr)
    } catch (e) { console.warn('[diag] on-chain sqrt fallback to JS approx:', e) }

    const sqrtC = freshSqrtC
    const tc    = freshTick
    const liq   = getLiquidityForAmounts(sqrtC, sqrtLChain, sqrtUChain, a0, a1)
    if (liq <= 0n) { addToast({ type: 'error', message: 'liquidity is zero, check range or amounts' }); return }

    const divUp  = (a: bigint, b: bigint) => a % b === 0n ? a / b : a / b + 1n
    let poolAmt0 = 0n, poolAmt1 = 0n
    if (tc < tickLower) {
      poolAmt0 = divUp(divUp(liq * Q96b * (sqrtUChain - sqrtLChain), sqrtUChain), sqrtLChain)
    } else if (tc < tickUpper) {
      poolAmt0 = divUp(divUp(liq * Q96b * (sqrtUChain - sqrtC), sqrtUChain), sqrtC)
      poolAmt1 = divUp(liq * (sqrtC - sqrtLChain), Q96b)
    } else {
      poolAmt1 = divUp(liq * (sqrtUChain - sqrtLChain), Q96b)
    }

    const isNative0 = poolInfo.token0 === CONTRACTS.woct

    if (isNative0 && poolAmt0 > 0n) {
      const total = baseUnits(nativeBalance)
      if (total - poolAmt0 < FEE_RESERVE) {
        addToast({ type: 'error', message:
          `keep at least ${formatBaseUnits(FEE_RESERVE, 6)} OCT for network fees — lower the amount` })
        return
      }
    }

    if (isNative0 && poolAmt0 > 0n) {
      if (BigInt(nativeBalance || '0') < poolAmt0) {
        const need = (Number(poolAmt0) / 1e6).toFixed(4)
        const have = (Number(nativeBalance || '0') / 1e6).toFixed(4)
        addToast({ type: 'error', message: `insufficient OCT: need ${need}, have ${have}` })
        return
      }
    }
    if (poolAmt1 > 0n) {
      const freshBal1 = await contractCallView<string>(poolInfo.token1, 'balance_of', [address]).catch(() => '0')
      if (BigInt(freshBal1 || '0') < poolAmt1) {
        const need = (Number(poolAmt1) / 1e6).toFixed(4)
        const have = (Number(freshBal1 || '0') / 1e6).toFixed(4)
        addToast({ type: 'error', message: `insufficient ${poolInfo.sym1}: need ${need}, have ${have}` })
        return
      }
    }

    type Step = {
      label:        string
      contract:     string
      method:       string
      params:       (string | number | boolean)[]
      value?:       string
      ou?:          string
    }
    const steps: Step[] = []

    if (isNative0 && poolAmt0 > 0n) {
      steps.push({
        label: 'wrap OCT to WOCT',
        contract: CONTRACTS.woct,
        method:   'deposit',
        params:   [],
        value:    poolAmt0.toString(),
      })
    }

    if (poolAmt0 > 0n) {
      steps.push({
        label:    `approve router for ${poolInfo.sym0}`,
        contract: poolInfo.token0,
        method:   'grant',
        params:   [CONTRACTS.router, poolAmt0.toString()],
      })
    }

    if (poolAmt1 > 0n) {
      steps.push({
        label:    `approve router for ${poolInfo.sym1}`,
        contract: poolInfo.token1,
        method:   'grant',
        params:   [CONTRACTS.router, poolAmt1.toString()],
      })
    }

    steps.push({
      label:    'add liquidity',
      contract: CONTRACTS.router,
      method:   'add_liquidity',
      params:   [poolAddress!, address, tickLower, tickUpper, liq.toString(), poolAmt0.toString(), poolAmt1.toString()],
      ou:       '200000',
    })

    const pause = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

    setLoading(true)
    setBusy(true)
    let lastHash = ''
    try {
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
        if (receipt && !receipt.success) throw new Error(`add liquidity failed: ${receipt.error ?? 'execution reverted'}`)
        if (!receipt) throw new Error(
          `the network has not confirmed this yet (${lastHash.slice(0, 12)}…). it may still go through — ` +
          `check your positions before adding again, or you could deposit twice.`)
        await refreshBalance()
      } else {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]

        const r = await callContract(s.contract, s.method, s.params, s.value ?? '0', s.ou)
        const txHash = r.txHash
        lastHash = txHash

        {
          await pause(2000)
          let receipt = await getReceipt(txHash)
          for (let t = 0; t < 29 && !receipt; t++) {
            await pause(2000)
            receipt = await getReceipt(txHash)
          }
          if (receipt && !receipt.success) {
            throw new Error(`step ${i + 1} (${s.label}) failed: ${receipt.error ?? 'execution reverted'}`)
          }
          if (!receipt) {
            throw new Error(
              `step ${i + 1} (${s.label}): the network has not confirmed this yet (${txHash.slice(0, 12)}…). ` +
              `it may still go through — check your positions before repeating.`)
          }
        }

        await refreshBalance()
      }
      }
      try {
        const pool = poolAddress ?? ''
        if (pool) {
          let baseOwed0 = '0', baseOwed1 = '0'
          try {
            const [, o0, o1] = await contractCallTuple(pool, 'get_position', [address, String(tickLower), String(tickUpper)])
            baseOwed0 = o0
            baseOwed1 = o1
          } catch {}

          const { savePosition } = await import('../utils/positions')
          await savePosition({ pool, owner: address, tickLower, tickUpper, addedAt: Date.now(), baseOwed0, baseOwed1 })
        }
      } catch {  }

      try {
        const { saveLPHistory } = await import('../utils/lpHistory')
        saveLPHistory(address, {
          type: 'add', hash: lastHash, timestamp: Date.now(),
          sym0: poolInfo.sym0, sym1: poolInfo.sym1,
          amt0: (Number(poolAmt0) / 1e6).toFixed(4),
          amt1: (Number(poolAmt1) / 1e6).toFixed(4),
        })
      } catch {}

      addToast({ type: 'success', message: 'liquidity added!', txHash: lastHash })
      navigate('/positions')
    } catch (e: unknown) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'error' })
    } finally {
      setLoading(false)
      setBusy(false)
    }
  }

  const priceLower   = tickToPrice(tickLower)
  const priceUpper   = tickToPrice(tickUpper)
  const currentPrice = poolInfo ? sqrtPriceToPrice(poolInfo.sqrtPrice, 6, 6) : 0
  const outOfRange   = poolInfo && (currentPrice < priceLower || currentPrice > priceUpper)

  const isToken0Oct  = !poolInfo || poolInfo.sym0 === 'OCT'
  const factPriceUsd = octPrice > 0 && currentPrice > 0
    ? (isToken0Oct ? octPrice / currentPrice : currentPrice * octPrice)
    : 0
  const boundFactor  = isToken0Oct ? factPriceUsd : (octPrice > 0 ? octPrice : 0)

  const usdOct  = (n: string) => '$' + (octPrice > 0 && Number(n) ? (Number(n) * octPrice).toFixed(2) : '0.00')
  const usdFact = (n: string) => '$' + (factPriceUsd > 0 && Number(n) ? (Number(n) * factPriceUsd).toFixed(2) : '0.00')
  const balFmt  = (raw: string) => (Number(raw) / 1e6).toFixed(4)

  const octAmt   = isToken0Oct ? amount0 : amount1
  const factAmt  = isToken0Oct ? amount1 : amount0
  const totalV   = Number(octAmt) * octPrice + Number(factAmt) * factPriceUsd
  const t0Frac   = totalV > 0
    ? (isToken0Oct ? Number(octAmt) * octPrice : Number(factAmt) * factPriceUsd) / totalV
    : currentPrice > 0 ? calcOctFraction(currentPrice, priceLower, priceUpper) : 0.5
  const sym0Pct  = Math.round(t0Frac * 100)
  const sym1Pct  = 100 - sym0Pct

  const totalUsd = '$' + (octPrice > 0 && (Number(octAmt) || Number(factAmt))
    ? (Number(octAmt) * octPrice + Number(factAmt) * factPriceUsd).toFixed(2)
    : '0.00')

  const lPct = tickToPct(tickLower)
  const uPct = tickToPct(tickUpper)
  const FRAME_MS: Record<typeof frame, number> = {
    '1h': 3_600_000, '6h': 21_600_000, '1d': 86_400_000, '1w': 604_800_000,
    all: 0,
  }

  const CANDLE_SLOT = Math.max(3, Math.min(40, 11 * zoom))
  const CANDLE_BODY = Math.max(1.5, CANDLE_SLOT * 0.64)

  const candles = (() => {
    type C = { t: number; o: number; h: number; l: number; c: number }
    if (priceHistory.length < 2) return [] as C[]

    const first = priceHistory[0].epoch
    const last  = priceHistory[priceHistory.length - 1].epoch
    const usable = Math.max(0, (chartWidth || 640) - M_RIGHT - AXIS_W)
    const slots = Math.max(6, Math.floor(usable / CANDLE_SLOT))

    const step = FRAME_MS[frame] > 0
      ? FRAME_MS[frame]
      : Math.max(60_000, Math.ceil(Math.max(60_000, last - first) / slots))

    const byBucket = new Map<number, number[]>()
    for (const h of priceHistory) {
      if (!(h.price > 0)) continue
      const b = Math.floor(h.epoch / step)
      const arr = byBucket.get(b)
      if (arr) arr.push(h.price)
      else byBucket.set(b, [h.price])
    }

    const all: C[] = [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, px]) => ({
        t: b * step,
        o: px[0], c: px[px.length - 1],
        h: Math.max(...px), l: Math.min(...px),
      }))

    void slots
    return all
  })()

  const stepMs = (() => {
    if (FRAME_MS[frame] > 0) return FRAME_MS[frame]
    if (candles.length > 1) return Math.max(60_000, candles[1].t - candles[0].t)
    return 3_600_000
  })()

  const plotW = Math.max(0, (chartWidth || 640) - M_RIGHT - AXIS_W)
  const candleX = (i: number) =>
    plotW - panPx - (candles.length - 1 - i) * CANDLE_SLOT - CANDLE_SLOT / 2

  const timeAtX = (x: number) => {
    if (candles.length === 0) return 0
    const idx = candles.length - 1 - (plotW - panPx - x - CANDLE_SLOT / 2) / CANDLE_SLOT
    return candles[0].t + idx * stepMs
  }

  const timeMarks = (() => {
    const out: { x: number; t: number }[] = []
    if (plotW <= 0 || candles.length === 0) return out
    const gap = 78
    for (let x = plotW - 22; x > 14; x -= gap) out.push({ x, t: timeAtX(x) })
    return out.reverse()
  })()

  const shownCandles = candles
    .map((c, i) => ({ c, x: candleX(i), i }))
    .filter(v => v.x > -CANDLE_SLOT && v.x < plotW + CANDLE_SLOT)

  const bandRef = useRef<[number, number] | null>(null)
  const autoBand = (() => {
    if ((panning || dragging) && bandRef.current) return bandRef.current
    const fallback: [number, number] = [currentPrice * 0.8, currentPrice * 1.25]
    if (!poolInfo || !(currentPrice > 0)) return fallback
    const vals = [currentPrice]
    const inView = shownCandles.length > 0 ? shownCandles.map(v => v.c) : candles.slice(-20)
    for (const c of inView) { vals.push(c.h); vals.push(c.l) }
    const good = vals.filter(v => Number.isFinite(v) && v > 0)
    if (good.length < 2) return fallback
    let lo = Math.min(...good), hi = Math.max(...good)
    if (!(hi > lo)) return fallback
    const pad = Math.pow(hi / lo, 0.08)
    return [lo / pad, hi * pad] as [number, number]
  })()
  if (!panning && !dragging) bandRef.current = autoBand

  const priceBand = (() => {
    const [lo, hi] = autoBand
    if (!(hi > lo)) return autoBand
    const logRange = Math.log(hi / lo)
    const mid = Math.sqrt(lo * hi) * Math.exp(vShift * logRange)
    const half = (logRange / 2) * vZoom
    return [mid / Math.exp(half), mid * Math.exp(half)] as [number, number]
  })()

  const priceToFrac = (price: number) => {
    const [lo, hi] = priceBand
    if (!(price > 0) || !(hi > lo)) return 0.5
    return Math.max(0, Math.min(1, Math.log(price / lo) / Math.log(hi / lo)))
  }
  const fracToPrice = (frac: number) => {
    const [lo, hi] = priceBand
    return lo * Math.pow(hi / lo, Math.max(0, Math.min(1, frac)))
  }
  fracRef.current = fracToPrice

  const tickTop = (tick: number) => {
    if (!poolInfo) return M_TOP + PLOT_H / 2
    if (rangeView === 'price') return M_TOP + (1 - priceToFrac(tickToPrice(tick))) * PLOT_H
    const frac = (tick - (poolInfo.currentTick - viewSpan)) / (viewSpan * 2)
    return M_TOP + (1 - Math.max(0, Math.min(1, frac))) * PLOT_H
  }

  const lLeft = chartWidth > 0 ? `${Math.round(lPct / 100 * chartWidth)}px` : `${lPct}%`
  const uLeft = chartWidth > 0 ? `${Math.round(uPct / 100 * chartWidth)}px` : `${uPct}%`
  const showHandles = currentPrice > 0
  const LW = 72
  const HW = isMobile ? 30 : 20
  const HH = isMobile ? 44 : 32

  return (
    <Page>

      <PageHead
        title={poolInfo ? `${poolInfo.sym0} / ${poolInfo.sym1}` : 'pool'}
        busy={!poolInfo}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {poolInfo && (
              <span className="ui-chip" style={{ height: 28, fontSize: 12 }}>
                {(poolInfo.fee / 10000).toFixed(2)}%
              </span>
            )}
            <button onClick={() => navigate(-1)} className="ui-ghost" style={{ height: 38, padding: '0 16px', fontSize: 13 }}>
              back
            </button>
          </div>
        }
      />

      {poolInfo && (
        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {[
            { label: 'liquidity',  value: metrics ? '$' + formatCompact(metrics.tvl) : '…' },
            { label: 'volume 24h', value: '$' + formatCompact(metrics?.volume24h ?? 0) },
            { label: 'fees 24h',   value: '$' + formatCompact(metrics?.fees24h ?? 0) },
          ].map(s => (
            <div key={s.label} className="bg-surface border border-border" style={{ padding: '12px 16px', height: 70, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="text-xs text-muted" style={{ letterSpacing: '0.5px' }}>{s.label}</div>
              <div className="text-ink font-mono" style={{ fontSize: 18, marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {!poolInfo ? (
        loadError ? (
          <div className="flex flex-col items-start gap-3">
            <p style={{ fontSize: 14, color: 'var(--oct-color-danger)' }}>failed to load pool, rpc error (429 rate limit)</p>
            <button
              onClick={loadPool}
              style={{
                fontSize: 14, padding: '7px 20px',
                border: '1px solid var(--oct-color-primary)',
                background: 'transparent', color: 'var(--oct-color-primary)',
                cursor: 'pointer',
              }}
            >retry</button>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>loading pool data...</p>
        )
      ) : (
        <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 400px', alignItems: 'stretch' }}>

          <div className="bg-surface border border-border p-6 flex flex-col gap-5">

            <div className="flex items-start justify-between" style={{ gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--oct-color-muted)', letterSpacing: '0.5px' }}>
                  current price
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily: 'var(--oct-type-mono)', fontSize: 30, fontWeight: 500,
                    letterSpacing: '-0.02em', color: 'var(--oct-color-text)', lineHeight: 1.1,
                  }}>{formatNumber(currentPrice, 6)}</span>
                  <span style={{ fontSize: 13, color: 'var(--oct-color-muted)' }}>
                    {poolInfo.sym1} per {poolInfo.sym0}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--oct-type-mono)', fontSize: 12, color: 'var(--oct-color-faint)', marginTop: 5 }}>
                  {currentPrice > 0 ? formatNumber(1 / currentPrice, 6) : '0'}{' '}
                  <span style={{ fontFamily: 'var(--oct-type-ui)' }}>{poolInfo.sym0} per {poolInfo.sym1}</span>
                </div>

                {oracle && (
                  <div style={{ fontFamily: 'var(--oct-type-mono)', fontSize: 12, color: 'var(--oct-color-faint)', marginTop: 4 }}>
                    {formatNumber(oracle.price, 6)}{' '}
                    <span style={{ fontFamily: 'var(--oct-type-ui)' }}>oracle</span>
                    {deviationPercent(oracle.spread) >= ALARM && (
                      <span style={{ fontFamily: 'var(--oct-type-ui)', color: 'var(--oct-color-warning)' }}>
                        {'  ·  price moving: '}
                        {deviationPercent(oracle.spread).toFixed(2)}%
                        {' between windows'}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {outOfRange && (
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--oct-color-warning)', whiteSpace: 'nowrap' }}>
                    out of range
                  </span>
                )}
                <Segmented
                  items={[{ value: 'liquidity', label: 'liquidity' }, { value: 'price', label: 'price' }]}
                  value={rangeView}
                  onChange={v => setRangeView(v)}
                  height={26}
                />
              </div>
              {rangeView === 'price' && (
                <Segmented
                  items={[
                    { value: '1h', label: '1h' }, { value: '6h', label: '6h' },
                    { value: '1d', label: '1d' }, { value: '1w', label: '1w' },
                    { value: 'all', label: 'all' },
                  ]}
                  value={frame}
                  onChange={v => setFrame(v)}
                  height={24}
                  mono
                />
              )}
              </div>
            </div>

            <div
              ref={chartRef}
              className="chart-area"
              style={{ position: 'relative', height: CHART_H, userSelect: 'none', overflow: 'hidden' }}
            >
              {showHandles && rangeView === 'liquidity' && (
                <>
                  <div style={{
                    position: 'absolute',
                    left: lLeft,
                    top: M_TOP,
                    height: PLOT_H,
                    width: 0,
                    zIndex: 20,
                  }}>
                    <div style={{
                      position: 'absolute', top: 0, left: -1, width: 2, height: '100%',
                      background: 'var(--oct-color-active)',
                    }} />
                    <div
                      onMouseDown={e => { e.preventDefault(); setDragging('lower') }}
                      onTouchStart={e => { e.preventDefault(); setDragging('lower') }}
                      style={{
                        position: 'absolute', top: 8, left: -(LW / 2), width: LW,
                        background: 'var(--oct-color-surface)', border: '1px solid var(--oct-color-border)',
                        fontSize: 15, color: 'var(--oct-color-text)', textAlign: 'center',
                        padding: '3px 0', fontFamily: 'var(--oct-type-mono)',
                        cursor: 'ew-resize', touchAction: 'none', whiteSpace: 'nowrap',
                      }}
                    >{pct(priceLower, currentPrice)}</div>
                    <div
                      onMouseDown={e => { e.preventDefault(); setDragging('lower') }}
                      onTouchStart={e => { e.preventDefault(); setDragging('lower') }}
                      style={{
                        position: 'absolute',
                        top: Math.round(PLOT_H / 2 - HH / 2),
                        left: -(HW / 2), width: HW, height: HH,
                        background: 'var(--oct-color-active)', border: 'none', borderRadius: 6,
                        cursor: 'ew-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        gap: 2,
                      }}
                    >
                      {[0, 1, 2].map(i => (
                        <div key={i} style={{ width: 1.5, height: 10, borderRadius: 1, background: 'var(--oct-color-action-ink)', opacity: 0.7 }} />
                      ))}
                    </div>
                  </div>

                  <div style={{
                    position: 'absolute',
                    left: uLeft,
                    top: M_TOP,
                    height: PLOT_H,
                    width: 0,
                    zIndex: 20,
                  }}>
                    <div style={{
                      position: 'absolute', top: 0, left: -1, width: 2, height: '100%',
                      background: 'var(--oct-color-active)',
                    }} />
                    <div
                      onMouseDown={e => { e.preventDefault(); setDragging('upper') }}
                      onTouchStart={e => { e.preventDefault(); setDragging('upper') }}
                      style={{
                        position: 'absolute', top: 8, left: -(LW / 2), width: LW,
                        background: 'var(--oct-color-surface)', border: '1px solid var(--oct-color-border)',
                        fontSize: 15, color: 'var(--oct-color-text)', textAlign: 'center',
                        padding: '3px 0', fontFamily: 'var(--oct-type-mono)',
                        cursor: 'ew-resize', touchAction: 'none', whiteSpace: 'nowrap',
                      }}
                    >{pct(priceUpper, currentPrice)}</div>
                    <div
                      onMouseDown={e => { e.preventDefault(); setDragging('upper') }}
                      onTouchStart={e => { e.preventDefault(); setDragging('upper') }}
                      style={{
                        position: 'absolute',
                        top: Math.round(PLOT_H / 2 - HH / 2),
                        left: -(HW / 2), width: HW, height: HH,
                        background: 'var(--oct-color-active)', border: 'none', borderRadius: 6,
                        cursor: 'ew-resize', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        gap: 2,
                      }}
                    >
                      {[0, 1, 2].map(i => (
                        <div key={i} style={{ width: 1.5, height: 10, borderRadius: 1, background: 'var(--oct-color-action-ink)', opacity: 0.7 }} />
                      ))}
                    </div>
                  </div>
                </>
              )}

              {rangeView === 'liquidity' && (
              <ResponsiveContainer width="100%" height={CHART_H}>
                <ComposedChart
                  data={bars}
                  margin={{ top: M_TOP, right: M_RIGHT, bottom: M_BOT, left: 0 }}
                >
                  <defs>
                    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--oct-color-primary)" stopOpacity={0.55} />
                      <stop offset="95%" stopColor="var(--oct-color-primary)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="tick" type="number"
                    allowDataOverflow
                    domain={poolInfo
                      ? [poolInfo.currentTick - 4000, poolInfo.currentTick + 4000]
                      : ['dataMin', 'dataMax']}
                    tickFormatter={v => tickToPrice(Number(v)).toFixed(4)}
                    tick={{ fontSize: 13, fill: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--oct-color-border)' }}
                    tickCount={6}
                  />
                  <ReferenceArea
                    x1={tickLower} x2={tickUpper}
                    fill="var(--oct-color-primary)" fillOpacity={0.13}
                    stroke="none"
                  />
                  <Area
                    type="monotone" dataKey="liq"
                    stroke="var(--oct-color-primary)" strokeWidth={2}
                    fill="url(#areaFill)"
                    isAnimationActive={false} dot={false}
                  />
                  <ReferenceLine
                    x={poolInfo.currentTick}
                    stroke="var(--oct-color-text)" strokeDasharray="3 3"
                    strokeWidth={1.5} strokeOpacity={0.5}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              )}

              {rangeView === 'price' && poolInfo && (
                <>
                  <div
                    onWheel={e => {
                      const dir = e.deltaY > 0 ? 1 / 1.15 : 1.15
                      setZoom(z => Math.max(0.35, Math.min(3.5, z * dir)))
                    }}
                    onMouseDown={e => {
                      if ((e.target as HTMLElement).closest('[data-range-handle]')) return
                      e.preventDefault()
                      setPanning({ x: e.clientX, y: e.clientY, pan: panPx, vs: vShift, vz: vZoom, mode: 'chart' })
                    }}
                    style={{
                      position: 'absolute', left: AXIS_W, right: M_RIGHT, top: M_TOP, height: PLOT_H,
                      cursor: panning ? 'grabbing' : 'grab', touchAction: 'none',
                    }}
                    onDoubleClick={() => { setPanPx(0); setZoom(1); setVShift(0); setVZoom(1) }}
                  >
                    {candles.length > 1 ? (
                      <svg width="100%" height={PLOT_H} style={{ display: 'block', overflow: 'visible' }}>
                        {shownCandles.map(({ c, x: cx }) => {
                          const y = (v: number) => (1 - priceToFrac(v)) * PLOT_H
                          const up = c.c >= c.o
                          const col = up ? 'var(--oct-color-success)' : 'var(--oct-color-danger)'
                          const top = y(Math.max(c.o, c.c))
                          const bot = y(Math.min(c.o, c.c))
                          return (
                            <g key={c.t}>
                              <title>{`${formatNumber(c.o, 6)} → ${formatNumber(c.c, 6)}`}</title>
                              <line
                                x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)}
                                stroke={col} strokeWidth={1} opacity={0.8}
                              />
                              <rect
                                x={cx - CANDLE_BODY / 2} width={CANDLE_BODY}
                                y={top} height={Math.max(1.5, bot - top)}
                                fill={col} opacity={up ? 0.9 : 0.85} rx={1}
                              />
                            </g>
                          )
                        })}
                      </svg>
                    ) : (
                      <div style={{
                        height: PLOT_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12.5, color: 'var(--oct-color-faint)',
                      }}>no trades yet</div>
                    )}

                    <div style={{
                      position: 'absolute', left: 0, right: 0,
                      top: tickTop(poolInfo.currentTick) - M_TOP,
                      borderTop: '1px dashed var(--oct-color-text)', opacity: 0.45,
                    }} />

                    <div style={{
                      position: 'absolute', left: 0, right: 0,
                      top: tickTop(tickUpper) - M_TOP,
                      height: Math.max(0, tickTop(tickLower) - tickTop(tickUpper)),
                      background: 'var(--oct-color-active)', opacity: 0.13, pointerEvents: 'none',
                    }} />
                  </div>

                  <div style={{ position: 'absolute', left: AXIS_W, right: M_RIGHT, top: M_TOP, height: PLOT_H, pointerEvents: 'none' }}>
                    {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => (
                      <div key={f} style={{
                        position: 'absolute', left: 0, right: 0, top: (1 - f) * PLOT_H,
                        borderTop: '1px solid var(--oct-color-border)', opacity: 0.55,
                      }} />
                    ))}
                  </div>

                  <div
                    title="drag to stretch the scale"
                    onMouseDown={e => {
                      e.preventDefault()
                      setPanning({ x: e.clientX, y: e.clientY, pan: panPx, vs: vShift, vz: vZoom, mode: 'scale' })
                    }}
                    onDoubleClick={() => { setVShift(0); setVZoom(1) }}
                    style={{
                      position: 'absolute', left: 0, top: M_TOP, width: AXIS_W, height: PLOT_H,
                      cursor: 'ns-resize', touchAction: 'none',
                    }}
                  >
                    {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => (
                      <div key={f} style={{
                        position: 'absolute', right: 8, top: (1 - f) * PLOT_H - 7,
                        fontFamily: 'var(--oct-type-mono)', fontSize: 10.5,
                        color: 'var(--oct-color-faint)', whiteSpace: 'nowrap',
                      }}>{formatNumber(fracToPrice(f), fracToPrice(f) < 1 ? 5 : 3)}</div>
                    ))}
                  </div>

                  <div style={{ position: 'absolute', left: AXIS_W, right: M_RIGHT, top: M_TOP + PLOT_H + 7, height: 16 }}>
                  <div style={{ position: 'absolute', left: AXIS_W, right: M_RIGHT, top: M_TOP, height: PLOT_H, pointerEvents: 'none', overflow: 'hidden' }}>
                    {timeMarks.map(m => m.x).map(x => (
                      <div key={x} style={{
                        position: 'absolute', top: 0, bottom: 0, left: x, width: 1,
                        background: 'var(--oct-color-border)', opacity: 0.45,
                      }} />
                    ))}
                  </div>

                    {timeMarks.map(({ x: cx, t }) => {
                      const d = new Date(t)
                      const short = frame === '1h' || frame === '6h'
                      const text = short
                        ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                        : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`
                      return (
                        <div key={cx} style={{
                          position: 'absolute', left: cx, transform: 'translateX(-50%)',
                          fontFamily: 'var(--oct-type-mono)', fontSize: 10.5,
                          color: 'var(--oct-color-faint)', whiteSpace: 'nowrap',
                        }}>{text}</div>
                      )
                    })}
                  </div>

                  {([['upper', tickUpper, priceUpper], ['lower', tickLower, priceLower]] as const).map(([which, t, pr]) => (
                    <div
                      key={which}
                      data-range-handle=""
                      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); setDragging(which) }}
                      onTouchStart={e => { e.preventDefault(); setDragging(which) }}
                      style={{
                        position: 'absolute', left: AXIS_W, right: M_RIGHT,
                        top: tickTop(t) - 9, height: 18, zIndex: 20,
                        cursor: 'ns-resize', touchAction: 'none',
                      }}
                    >
                      <div style={{
                        position: 'absolute', left: 0, right: 0, top: 8, height: 2,
                        background: 'var(--oct-color-active)',
                        opacity: dragging === which ? 1 : 0.85,
                      }} />
                      <div style={{
                        position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 0,
                        width: 22, height: 18, borderRadius: 6,
                        background: 'var(--oct-color-active)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
                      }}>
                        {[0, 1, 2].map(i => (
                          <span key={i} style={{
                            width: 1.5, height: 8, borderRadius: 1,
                            background: 'var(--oct-color-action-ink)', opacity: 0.7,
                          }} />
                        ))}
                      </div>
                      <div style={{
                        position: 'absolute', right: 0, top: -2,
                        height: 22, padding: '0 8px', borderRadius: 7,
                        display: 'inline-flex', alignItems: 'center',
                        background: 'var(--oct-color-active)', color: 'var(--oct-color-action-ink)',
                        fontFamily: 'var(--oct-type-mono)', fontSize: 11.5, whiteSpace: 'nowrap',
                        boxShadow: dragging === which ? '0 0 0 2px var(--oct-color-bg)' : 'none',
                      }}>{formatNumber(pr, 6)}</div>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="ui-inset" style={{ padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
                <p className="text-xs text-muted">min price</p>
                <input
                  type="number"
                  value={minPriceEdit ?? priceLower.toFixed(6)}
                  onChange={e => setMinPriceEdit(e.target.value)}
                  onBlur={() => {
                    if (minPriceEdit !== null) {
                      const p = Number(minPriceEdit)
                      if (p > 0 && p < priceUpper)
                        setTickLower(nearestUsableTick(priceToTick(p), poolInfo.tickSpacing))
                      setMinPriceEdit(null)
                    }
                  }}
                  onFocus={e => setMinPriceEdit(e.target.value)}
                  className="w-full bg-transparent text-base text-ink outline-none font-mono text-center"
                />
                <p className="text-xs text-muted">{poolInfo.sym1} per {poolInfo.sym0}</p>
                <p className="text-xs font-mono" style={{ color: 'var(--oct-color-primary)' }}>
                  ${boundFactor > 0 ? (priceLower * boundFactor).toFixed(4) : '0.0000'}
                </p>
              </div>

              <div className="ui-inset" style={{ padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
                <p className="text-xs text-muted">max price</p>
                <input
                  type="number"
                  value={maxPriceEdit ?? priceUpper.toFixed(6)}
                  onChange={e => setMaxPriceEdit(e.target.value)}
                  onBlur={() => {
                    if (maxPriceEdit !== null) {
                      const p = Number(maxPriceEdit)
                      if (p > priceLower)
                        setTickUpper(nearestUsableTick(priceToTick(p), poolInfo.tickSpacing))
                      setMaxPriceEdit(null)
                    }
                  }}
                  onFocus={e => setMaxPriceEdit(e.target.value)}
                  className="w-full bg-transparent text-base text-ink outline-none font-mono text-center"
                />
                <p className="text-xs text-muted">{poolInfo.sym1} per {poolInfo.sym0}</p>
                <p className="text-xs font-mono" style={{ color: 'var(--oct-color-primary)' }}>
                  ${boundFactor > 0 ? (priceUpper * boundFactor).toFixed(4) : '0.0000'}
                </p>
              </div>

              <div className="ui-inset" style={{ padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
                <p className="text-xs text-muted">estimated APR</p>
                <p className="text-3xl text-success" style={{ fontFamily: 'var(--oct-type-mono)' }}>
                  {metrics && metrics.apr > 0
                    ? (metrics.apr >= 1000 ? Math.round(metrics.apr).toLocaleString() : metrics.apr.toFixed(1)) + '%'
                    : '0%'}
                </p>
              </div>
            </div>

            {outOfRange && (
              <div className="text-xs text-warning border border-warning/30 bg-warning/5 px-3 py-2">
                current price is outside your range, only one token will be deposited
              </div>
            )}
          </div>

          <div className="ui-card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

            <span className="text-sm font-medium text-ink">add deposit amount</span>

            <div className="ui-inset" style={{ padding: 16 }}>
              <div className="flex items-center justify-between text-xs text-muted mb-2">
                <span className="text-sm font-medium text-ink">{poolInfo.sym0}</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono">{balFmt(bal0)}</span>
                  <button
                    onClick={() => onAmount0Change(formatBaseUnits(baseUnits(bal0) / 2n, 6))}
                    className="ui-chip"
                  >50%</button>
                  <button
                    onClick={() => onAmount0Change(formatBaseUnits(spendable0(), 6))}
                    className="ui-chip"
                  >max</button>
                </div>
              </div>
              <input
                type="number" value={amount0}
                onChange={e => onAmount0Change(e.target.value)}
                placeholder="0.000000"
                className="w-full bg-transparent text-2xl text-ink outline-none placeholder-border font-mono"
                style={{ border: 'none', boxShadow: 'none', padding: 0 }}
              />
              <p className="text-xs text-muted mt-2 font-mono">{isToken0Oct ? usdOct(amount0) : usdFact(amount0)}</p>
            </div>

            <div className="flex justify-center">
              <span className="w-7 h-7 border border-border flex items-center justify-center text-muted text-sm bg-bg">+</span>
            </div>

            <div className="ui-inset" style={{ padding: 16 }}>
              <div className="flex items-center justify-between text-xs text-muted mb-2">
                <span className="text-sm font-medium text-ink">{poolInfo.sym1}</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono">{balFmt(bal1)}</span>
                  <button
                    onClick={() => onAmount1Change(formatBaseUnits(baseUnits(bal1) / 2n, 6))}
                    className="ui-chip"
                  >50%</button>
                  <button
                    onClick={() => onAmount1Change(formatBaseUnits(baseUnits(bal1), 6))}
                    className="ui-chip"
                  >max</button>
                </div>
              </div>
              <input
                type="number" value={amount1}
                onChange={e => onAmount1Change(e.target.value)}
                placeholder="0.000000"
                className="w-full bg-transparent text-2xl text-ink outline-none placeholder-border font-mono"
                style={{ border: 'none', boxShadow: 'none', padding: 0 }}
              />
              <p className="text-xs text-muted mt-2 font-mono">{isToken0Oct ? usdFact(amount1) : usdOct(amount1)}</p>
            </div>

            <button
              onClick={doAdd}
              disabled={connected && ((!amount0 && !amount1) || loading)}
              className="w-full py-3 text-sm font-semibold bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {!connected ? 'connect wallet' : loading ? 'adding...' : 'add liquidity'}
            </button>

            <div className="mt-auto pt-4 border-t border-border space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted">
                  <span style={{ width: 10, height: 10, background: 'var(--oct-color-active)', display: 'inline-block' }} />
                  {poolInfo.sym0}
                  <span className="text-ink font-semibold">{sym0Pct}%</span>
                </span>
                <span className="flex items-center gap-2 text-muted">
                  <span className="text-ink font-semibold">{sym1Pct}%</span>
                  {poolInfo.sym1}
                  <span style={{ width: 10, height: 10, background: 'var(--oct-color-border)', display: 'inline-block' }} />
                </span>
              </div>

              <div style={{
                height: 12,
                background: 'var(--oct-color-border)',
                border: '1px solid var(--oct-color-border)',
                overflow: 'hidden',
                position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0,
                  height: '100%',
                  width: `${sym0Pct}%`,
                  background: 'var(--oct-color-active)',
                  transition: 'width 0.25s ease',
                }} />
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">total deposit</span>
                <span className="text-ink font-semibold font-mono">{totalUsd}</span>
              </div>
            </div>

          </div>
        </div>
      )}
    </Page>
  )
}
