import { useState, useEffect, useCallback, useRef } from 'react'
import { useWallet, CONTRACTS } from '../context/WalletContext'
import { getEpochId, contractCallTuple, contractCallView, getOctMarket, getReceipt, getTxStatus, getRecommendedFee, submitMultiExec, BATCH_LIMIT, type MultiExecCall, lastOctPrice } from '../utils/rpc'
import { listTokens, onTokensChanged, duplicateSymbols } from '../config/tokens'
import { spendableNative, formatBaseUnits } from '../utils/gas'
import { getTokenPriceUsd, getTokenPricesUsd } from '../utils/price'
import { getAllPools, bestPoolForPair, routeMatches, type PoolMeta } from '../utils/pools'
import { recordFactPrice, getFactChange24h } from '../utils/priceHistory'
import TokenIcon from '../components/TokenIcon'
import Segmented from '../components/Segmented'

type RouteType = '1hop' | '2hop' | 'none'

interface Token { address: string; symbol: string; decimals: number; verified?: boolean }

import { saveSwapHistory, type SwapRecord } from '../utils/swapHistory'
import { toBaseUnits, fromBaseUnits, bumpDown, bumpUp } from '../utils/format'

const OCT:  Token = { address: 'NATIVE',       symbol: 'OCT',  decimals: 6 }
const WOCT: Token = { address: CONTRACTS.woct, symbol: 'WOCT', decimals: 6 }
const FACT: Token = { address: CONTRACTS.fact, symbol: 'FACT', decimals: 6 }
function knownTokens(): Token[] {
  return listTokens().map(t => t.native ? OCT : { address: t.address, symbol: t.symbol, decimals: t.decimals, verified: t.verified })
}

function poolToken(t: Token): Token {
  return t.address === 'NATIVE' ? WOCT : t
}

const FEE_TIERS = [
  { value: 500,   label: '0.05%' },
  { value: 3000,  label: '0.30%' },
  { value: 10000, label: '1.00%' },
]
const feeLabel = (v: number) => FEE_TIERS.find(f => f.value === v)?.label ?? (v / 10000).toFixed(2) + '%'
const SLIPPAGE_OPTIONS = [0.5, 1.0, 2.0]
const SLIPPAGE_MIN = 0.01
const SLIPPAGE_MAX = 50

async function realImpact(tokenIn: string, tokenOut: string, fee: string | number, amtInRaw: string, amtOutRaw: number, fallbackPct: number): Promise<number> {
  const amtIn = Number(amtInRaw)
  if (!(amtIn > 0)) return fallbackPct
  if (!(amtOutRaw > 0)) return 100
  try {
    const spotInRaw = Math.max(1, Math.floor(amtIn / 10000))
    const r = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single', [tokenIn, tokenOut, String(fee), String(spotInRaw), '0'])
    const spotOut = Number(r[0])
    if (spotOut > 0) {
      const execRate = amtOutRaw / amtIn
      const spotRate = spotOut / spotInRaw
      if (spotRate > 0) return Math.min(100, Math.max(0, (1 - execRate / spotRate) * 100))
    }
  } catch {  }
  return fallbackPct
}
async function realImpact2hop(tokenIn: string, mid: string, tokenOut: string, fee1: number, fee2: number, amtInRaw: string, amtOutRaw: number, fallbackPct: number): Promise<number> {
  const amtIn = Number(amtInRaw)
  if (!(amtIn > 0)) return fallbackPct
  if (!(amtOutRaw > 0)) return 100
  try {
    const spotInRaw = Math.max(1, Math.floor(amtIn / 10000))
    const h1 = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single', [tokenIn, mid, String(fee1), String(spotInRaw), '0'])
    const h1Out = Number(h1[0])
    if (h1Out > 0) {
      const h2 = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single', [mid, tokenOut, String(fee2), String(h1Out), '0'])
      const spotOut = Number(h2[0])
      if (spotOut > 0) {
        const execRate = amtOutRaw / amtIn
        const spotRate = spotOut / spotInRaw
        if (spotRate > 0) return Math.min(100, Math.max(0, (1 - execRate / spotRate) * 100))
      }
    }
  } catch {  }
  return fallbackPct
}

type QuoteStatus = 'idle' | 'quoting' | 'ok' | 'no_liq' | 'too_big' | 'disabled'

export default function Swap() {
  const { address, balance: octBalanceRaw, connected, connectMethod, addToast, openConnectModal, setBusy, callContract, getSessionPin, clearSessionPin } = useWallet()

  const [tokenIn,   setTokenIn]   = useState<Token | null>(null)
  const [tokenOut,  setTokenOut]  = useState<Token | null>(null)
  const [fee,       setFee]       = useState(3000)
  const [amtIn,     setAmtIn]     = useState('')
  const [amtOut,    setAmtOut]    = useState('')
  const [lastEdited, setLastEdited] = useState<'in' | 'out'>('in')
  const [slippage,  setSlippage]  = useState(1.0)
  const [customSlip, setCustomSlip] = useState('')
  const [priceImpact, setPriceImpact] = useState(0)
  const [maxHintIn, setMaxHintIn] = useState<number | null>(null)
  const maxInCache = useRef<Record<string, number>>({})
  const [loading,   setLoading]   = useState(false)
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus>('idle')
  const [showTokenModal, setShowTokenModal] = useState<'in' | 'out' | null>(null)
  const [modalSearch, setModalSearch] = useState('')
  const [, setTokTick] = useState(0)
  const [balances, setBalances] = useState<Record<string, string>>({})
  const [octPrice,    setOctPrice]    = useState(lastOctPrice)
  const [impliedFactPrice, setImpliedFactPrice] = useState(0)
  const [poolFactPrice, setPoolFactPrice] = useState(0)
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({})
  const [contractCallOu, setContractCallOu] = useState(5000)
  const [octChange,  setOctChange]  = useState<number | null>(null)
  const [factChange, setFactChange] = useState<number | null>(null)
  const [routeType,    setRouteType]    = useState<RouteType>('none')
  const [tokenMid,     setTokenMid]     = useState<Token | null>(null)
  const [route2Fees,   setRoute2Fees]   = useState<{ fee1: number; fee2: number } | null>(null)
  const [topPools, setTopPools] = useState<{ address: string; token0: string; token1: string; fee: number }[]>([])
  useEffect(() => {
    let alive = true
    getAllPools(CONTRACTS.factory)
      .then(ps => {
        if (!alive) return
        const seen = new Set<string>()
        setTopPools([...ps]
          .filter(p => p.liquidity > 0 && (!p.router || p.router === CONTRACTS.router))
          .filter(p => !seen.has(p.address) && seen.add(p.address))
          .sort((a, b) => b.liquidity - a.liquidity).slice(0, 5)
          .map(p => ({ address: p.address, token0: p.token0, token1: p.token1, fee: p.fee })))
      })
      .catch(() => {  })
    return () => { alive = false }
  }, [])
  const tokenByAddress = (addr: string) =>
    knownTokens().find(t => t.address === addr) ??
    (addr === CONTRACTS.woct ? knownTokens().find(t => t.symbol === 'OCT') : undefined)
  const symbolOf = (addr: string) => tokenByAddress(addr)?.symbol ?? addr.slice(0, 5)

  const settingsRef = useRef<HTMLDivElement>(null)
  const [settingsH, setSettingsH] = useState(0)
  useEffect(() => {
    const el = settingsRef.current
    if (!el) return
    const measure = () => setSettingsH(el.scrollHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [availableFees, setAvailableFees] = useState<number[]>([])

  useEffect(() => onTokensChanged(() => setTokTick(t => t + 1)), [])

  const knownTokenSig = knownTokens().map(t => t.address).join(',')
  useEffect(() => {
    if (!connected || !address) { setBalances({}); return }
    let alive = true
    const toks = knownTokens().filter(t => t.address !== 'NATIVE')
    Promise.all(toks.map(async t =>
      [t.address, (await contractCallView<string>(t.address, 'balance_of', [address]).catch(() => '0')) ?? '0'] as const))
      .then(pairs => { if (alive) setBalances(prev => ({ ...prev, ...Object.fromEntries(pairs) })) })
    return () => { alive = false }
  }, [connected, address, knownTokenSig])

  useEffect(() => {
    getOctMarket().then(m => { setOctPrice(m.price); setOctChange(m.change24h) }).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    getRecommendedFee('contract_call')
      .then(call => {
        if (!alive) return
        setContractCallOu(Math.max(call > 0 ? call : 0, 5000))
      })
      .catch(() => {  })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (octPrice <= 0) return
    getTokenPriceUsd(CONTRACTS.factory, CONTRACTS.woct, CONTRACTS.fact, octPrice, CONTRACTS.router).then(p => {
      setPoolFactPrice(p)
      recordFactPrice(p)
      setFactChange(getFactChange24h(p))
    }).catch(() => {})
  }, [octPrice])

  useEffect(() => {
    if (octPrice <= 0) return
    getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, octPrice, CONTRACTS.router).then(setTokenPrices).catch(() => {})
  }, [octPrice])

  useEffect(() => {
    if (!tokenIn || !tokenOut) { setAvailableFees([]); return }
    const a = poolToken(tokenIn).address, b = poolToken(tokenOut).address
    let alive = true
    getAllPools(CONTRACTS.factory).then(pools => {
      if (!alive) return
      const direct = pools.filter(p =>
        p.liquidity > 0 &&
        (!CONTRACTS.router || !p.router || p.router === CONTRACTS.router) &&
        ((p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a)))
      setAvailableFees(Array.from(new Set(direct.map(p => p.fee))))
      const best = bestPoolForPair(pools, a, b, CONTRACTS.router)
      if (best && best.fee !== fee) setFee(best.fee)
    }).catch(() => { if (alive) setAvailableFees([]) })
    return () => { alive = false }
  }, [tokenIn, tokenOut])

  const renderChange = (c: number | null) => {
    const v = c ?? 0
    const color = v > 0 ? '#1a8f4a' : v < 0 ? 'var(--oct-color-danger)' : 'var(--oct-color-muted)'
    return <span style={{ color, fontFamily: 'var(--oct-type-mono)' }}>{(v > 0 ? '+' : '') + v.toFixed(2)}%</span>
  }

  const octBalance = (Number(octBalanceRaw) / 1e6).toFixed(4)

  const tokenUsd = (t: Token | null, amt: string): string => {
    if (!t || !amt || Number(amt) === 0) return ''
    const isOct = t.address === 'NATIVE' || t.address === WOCT.address
    const price = isOct ? octPrice : (tokenPrices[t.address] ?? 0)
    if (price > 0) return `$${(Number(amt) * price).toFixed(2)}`
    return ''
  }

  function tokenBalance(t: Token): string {
    if (!connected) return '0.0000'
    if (t.address === 'NATIVE') {
      return octBalance
    }
    const raw = balances[t.address]
    return raw ? (Number(raw) / 10 ** t.decimals).toFixed(4) : '0.0000'
  }

  function rawBalance(t: Token): bigint {
    if (!connected) return 0n
    try {
      return BigInt(t.address === 'NATIVE' ? (octBalanceRaw || '0') : (balances[t.address] || '0'))
    } catch { return 0n }
  }

  function spendable(t: Token): bigint {
    const total = rawBalance(t)
    return t.address === 'NATIVE' ? spendableNative(total, publicGasOct) : total
  }

  const getQuote = useCallback(async () => {
    if (lastEdited !== 'in') return
    if (!tokenIn || !tokenOut) { setQuoteStatus('idle'); setAmtOut(''); setRouteType('none'); return }
    if (!amtIn || Number(amtIn) === 0) { setQuoteStatus('idle'); setAmtOut(''); setRouteType('none'); return }

    setQuoteStatus('quoting')
    const tIn  = poolToken(tokenIn)
    const tOut = poolToken(tokenOut)
    const amtInRaw = toBaseUnits(amtIn, tokenIn.decimals).toString()

    try {
      const res = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
        [tIn.address, tOut.address, fee, amtInRaw, '0'])
      const [amtOutRaw, , impactBps] = res
      const amtOutFmt = (Number(amtOutRaw) / 10 ** tokenOut.decimals).toFixed(6)
      setAmtOut(amtOutFmt)
      setPriceImpact(await realImpact(tIn.address, tOut.address, fee, amtInRaw, Number(amtOutRaw), Number(impactBps) / 100))
      setRouteType('1hop')
      setTokenMid(null)
      setRoute2Fees(null)
      setQuoteStatus('ok')
      if (Number(amtIn) > 0 && Number(amtOutFmt) > 0 && octPrice > 0) {
        if (tIn.address === WOCT.address) {
          setImpliedFactPrice(octPrice * Number(amtIn) / Number(amtOutFmt))
        } else if (tOut.address === WOCT.address) {
          setImpliedFactPrice(octPrice * Number(amtOutFmt) / Number(amtIn))
        }
      }
      return
    } catch (e1) {
      console.warn('[quote] 1-hop failed:', e1 instanceof Error ? e1.message : e1)
    }

    let pools: PoolMeta[] = []
    try { pools = await getAllPools(CONTRACTS.factory) } catch {  }

    const directBest = bestPoolForPair(pools, tIn.address, tOut.address, CONTRACTS.router)
    if (directBest) {
      if (directBest.fee !== fee) {
        try {
          const res = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
            [tIn.address, tOut.address, String(directBest.fee), amtInRaw, '0'])
          const [amtOutRaw, , impactBps] = res
          const amtOutFmt = (Number(amtOutRaw) / 10 ** tokenOut.decimals).toFixed(6)
          setFee(directBest.fee)
          setAmtOut(amtOutFmt)
          setPriceImpact(await realImpact(tIn.address, tOut.address, directBest.fee, amtInRaw, Number(amtOutRaw), Number(impactBps) / 100))
          setRouteType('1hop'); setTokenMid(null); setRoute2Fees(null); setQuoteStatus('ok')
          return
        } catch (e1b) {
          console.warn('[quote] direct-tier retry failed:', e1b instanceof Error ? e1b.message : e1b)
        }
      }
      const feeUse = directBest.fee
      const key = `${tIn.address}:${tOut.address}:${feeUse}`
      let maxRaw = maxInCache.current[key]
      if (maxRaw === undefined) {
        const fits = async (raw: number) => {
          try { await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
            [tIn.address, tOut.address, String(feeUse), String(raw), '0']); return true } catch { return false }
        }
        let lo = 0, hi = Math.max(1, Number(amtInRaw))
        for (let i = 0; i < 7; i++) { const midv = Math.floor((lo + hi) / 2); if (midv <= lo) break; if (await fits(midv)) lo = midv; else hi = midv }
        maxRaw = lo
        maxInCache.current[key] = maxRaw
      }
      setMaxHintIn(maxRaw > 0 ? maxRaw / 10 ** tokenIn.decimals : null)
      setAmtOut(''); setRouteType('none'); setQuoteStatus('too_big')
      return
    }

    const mid = (tIn.address === WOCT.address || tOut.address === WOCT.address) ? FACT : WOCT
    try {
      const p1 = bestPoolForPair(pools, tIn.address, mid.address, CONTRACTS.router)
      const p2 = bestPoolForPair(pools, mid.address, tOut.address, CONTRACTS.router)
      if (!p1 || !p2) throw new Error('no 2-hop route via ' + mid.symbol)
      const r1 = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
        [tIn.address, mid.address, String(p1.fee), amtInRaw, '0'])
      const [hop1Out] = r1
      const r2 = await contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
        [mid.address, tOut.address, String(p2.fee), String(hop1Out), '0'])
      const [amtOutRaw, , impactBps] = r2
      const amtOutFmt = (Number(amtOutRaw) / 10 ** tokenOut.decimals).toFixed(6)
      setAmtOut(amtOutFmt)
      setPriceImpact(await realImpact2hop(tIn.address, mid.address, tOut.address, p1.fee, p2.fee, amtInRaw, Number(amtOutRaw), Number(impactBps) / 100))
      setRouteType('2hop')
      setTokenMid(mid)
      setRoute2Fees({ fee1: p1.fee, fee2: p2.fee })
      setQuoteStatus('ok')
      return
    } catch (e2) {
      console.warn('[quote] 2-hop failed:', e2 instanceof Error ? e2.message : e2)
    }

    setAmtOut('')
    setRouteType('none')
    setQuoteStatus('no_liq')
  }, [tokenIn, tokenOut, amtIn, fee, octPrice, lastEdited])

  useEffect(() => { if (quoteStatus !== 'too_big') setMaxHintIn(null) }, [quoteStatus])

  useEffect(() => {
    const t = setTimeout(getQuote, 250)
    return () => clearTimeout(t)
  }, [getQuote])

  const getReverseQuote = useCallback(async () => {
    if (lastEdited !== 'out') return
    if (!tokenIn || !tokenOut) { setQuoteStatus('idle'); setAmtIn(''); setRouteType('none'); return }
    if (!amtOut || Number(amtOut) === 0) { setQuoteStatus('idle'); setAmtIn(''); setRouteType('none'); return }

    setQuoteStatus('quoting')
    const tIn  = poolToken(tokenIn)
    const tOut = poolToken(tokenOut)
    const amtOutRaw = toBaseUnits(amtOut, tokenOut.decimals).toString()
    try {
      const inRaw = await contractCallView<string>(CONTRACTS.quoter, 'quote_exact_output_single',
        [tIn.address, tOut.address, fee, amtOutRaw, '0'])
      if (!inRaw || Number(inRaw) <= 0) throw new Error('no exact-output quote')
      const amtInFmt = (Number(inRaw) / 10 ** tokenIn.decimals).toFixed(6)
      setAmtIn(amtInFmt)
      setPriceImpact(0)
      setRouteType('1hop')
      setTokenMid(null)
      setRoute2Fees(null)
      setQuoteStatus('ok')
      if (Number(amtInFmt) > 0 && Number(amtOut) > 0 && octPrice > 0) {
        if (tIn.address === WOCT.address)       setImpliedFactPrice(octPrice * Number(amtInFmt) / Number(amtOut))
        else if (tOut.address === WOCT.address) setImpliedFactPrice(octPrice * Number(amtOut) / Number(amtInFmt))
      }
    } catch (e) {
      console.warn('[reverse-quote] failed:', e instanceof Error ? e.message : e)
      setAmtIn('')
      setRouteType('none')
      setQuoteStatus('no_liq')
    }
  }, [lastEdited, tokenIn, tokenOut, amtOut, fee, octPrice])

  useEffect(() => {
    const t = setTimeout(getReverseQuote, 250)
    return () => clearTimeout(t)
  }, [getReverseQuote])

  const refreshQuote = useCallback(() => {
    if (lastEdited === 'out') getReverseQuote()
    else getQuote()
  }, [lastEdited, getQuote, getReverseQuote])

  const ownSlippage = (() => {
    const t = customSlip.trim()
    if (t === '') return null
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    return Math.min(Math.max(n, SLIPPAGE_MIN), SLIPPAGE_MAX)
  })()
  const effectiveSlippage = ownSlippage ?? slippage

  const flip = () => {
    setTokenIn(tokenOut); setTokenOut(tokenIn)
    setAmtIn(amtOut);     setAmtOut(amtIn)
    setLastEdited('in')
  }

  async function pollReceipt(hash: string, label: string, timeoutMs = 90000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 800))
      const r = await getReceipt(hash)
      if (r) {
        return r
      }
    }
    console.warn(`[swap:${label}] receipt timeout after ${timeoutMs}ms`)
    const status = await getTxStatus(hash).catch(() => '')
    if (status === 'rejected' || status === 'failed' || status === 'dropped') return null
    const head = hash.slice(0, 10)
    throw new Error(
      `the network has not confirmed this yet (${head}…). it may still go through — ` +
      `check the explorer before trying again, or you could pay twice.`
    )
  }

  const doSwap = async () => {
    if (!connected || !tokenIn || !tokenOut || !amtIn || !amtOut) return
    if (routeType === 'none') return
    if (priceImpact > 90) {
      addToast({ type: 'error', message: `price impact ${priceImpact.toFixed(0)}% is too high: this pool is too thin for that size. lower the amount.` })
      return
    }
    let epochAhead: Promise<number> = Promise.resolve(0)
    let estimateAhead: Promise<string[] | null> = Promise.resolve(null)
    {
      const legs = routeType === '2hop' && tokenMid && route2Fees
        ? [{ from: poolToken(tokenIn).address,  to: poolToken(tokenMid).address, feeTier: route2Fees.fee1 },
           { from: poolToken(tokenMid).address, to: poolToken(tokenOut).address, feeTier: route2Fees.fee2 }]
        : [{ from: poolToken(tokenIn).address,  to: poolToken(tokenOut).address, feeTier: fee }]
      epochAhead = getEpochId().catch(() => 0)
      if (routeType === '1hop' && lastEdited === 'in') {
        estimateAhead = contractCallTuple(CONTRACTS.quoter, 'quote_exact_input_single',
          [poolToken(tokenIn).address, poolToken(tokenOut).address, fee,
           toBaseUnits(amtIn, tokenIn.decimals).toString(), '0']).catch(() => null)
      }
      const check = await routeMatches(CONTRACTS.factory, legs)
      if (!check.ok) {
        addToast({ type: 'error', message:
          'this swap would go to the wrong pool: the factory treats a foreign contract ' +
          (check.foreign ?? '').slice(0, 10) + '… as canonical, not the one shown. swap stopped.' })
        return
      }
    }
    setLoading(true)
    setBusy(true)
    try {
      const tIn  = poolToken(tokenIn)
      const tOut = poolToken(tokenOut)
      const isNativeIn  = tokenIn.address  === 'NATIVE'
      const isNativeOut = tokenOut.address === 'NATIVE'
      const amtInRaw  = toBaseUnits(amtIn, tokenIn.decimals).toString()
      let amtOutMin = bumpDown(toBaseUnits(amtOut, tokenOut.decimals), effectiveSlippage).toString()

      const epochNow = await epochAhead
      const deadline = epochNow > 0
        ? String(epochNow + 100)
        : String(Math.floor(Date.now() / 1000) + 300)
      const router = CONTRACTS.router

      if (lastEdited === 'out' && routeType === '1hop') {
        const amtOutRaw = toBaseUnits(amtOut, tokenOut.decimals).toString()
        const amtInMax  = bumpUp(toBaseUnits(amtIn, tokenIn.decimals), effectiveSlippage).toString()
        const wrappedBefore = isNativeIn
          ? BigInt((await contractCallView<string>(CONTRACTS.woct, 'balance_of', [address]).catch(() => '0')) ?? '0')
          : 0n
        addToast({ type: 'pending', message: 'swapping...' })

        let xoHash: string
        let xoR: Awaited<ReturnType<typeof pollReceipt>>
        if (connectMethod === 'key') {
          const calls: MultiExecCall[] = []
          if (isNativeIn) calls.push({ address: CONTRACTS.woct, method: 'deposit', params: [], amount: amtInMax })
          calls.push({ address: tIn.address, method: 'grant', params: [router, amtInMax] })
          calls.push({ address: router, method: 'exact_output_single',
            params: [tIn.address, tOut.address, fee, address, deadline, amtOutRaw, amtInMax, '0'] })
          calls.push({ address: tIn.address, method: 'grant', params: [router, '0'] })
          const submit = async () => {
            const pin = await getSessionPin('Enter your wallet PIN to authorize the swap')
            if (!pin) throw new Error('PIN required to swap')
            return submitMultiExec(calls, String(contractCallOu), pin)
          }
          try { xoHash = await submit() }
          catch (e) { const m = e instanceof Error ? e.message : String(e); if (/\b403\b|PIN/i.test(m)) { clearSessionPin(); xoHash = await submit() } else throw e }
          xoR = await pollReceipt(xoHash, 'multi_exec_exactout')
          if (!xoR?.success) throw new Error(`swap failed: ${xoR?.error ?? 'no receipt'} | effort: ${xoR?.effort}`)
        } else {
          if (isNativeIn) {
            const { txHash: wrapHash } = await callContract(CONTRACTS.woct, 'deposit', [], amtInMax, '5000')
            if (!(await pollReceipt(wrapHash, 'wrap'))?.success) throw new Error('wrap failed')
          }
          const g = await callContract(tIn.address, 'grant', [router, amtInMax], '0', '5000')
          if (!(await pollReceipt(g.txHash, 'grant'))?.success) throw new Error('grant failed')
          const r = await callContract(router, 'exact_output_single',
            [tIn.address, tOut.address, fee, address, deadline, amtOutRaw, amtInMax, '0'], '0', String(contractCallOu))
          xoHash = r.txHash
          xoR = await pollReceipt(xoHash, 'router_exactout')
          if (!xoR?.success) throw new Error(`swap failed: ${xoR?.error ?? 'no receipt'} | effort: ${xoR?.effort}`)
        }

        if (isNativeOut) {
          const ev = ((xoR?.events ?? []) as unknown as Array<{ event?: string; values?: unknown[] }>)
            .find(e => e.event === 'SwapExecuted')
          const received = ev?.values ? BigInt(String(ev.values[5])) : 0n
          const unwrapping = (received > BigInt(amtOutRaw) ? received : BigInt(amtOutRaw)).toString()
          const { txHash: unwrapHash } = await callContract(CONTRACTS.woct, 'withdraw', [unwrapping], '0', '5000')
          if (!(await pollReceipt(unwrapHash, 'unwrap'))?.success) throw new Error('unwrap failed')
        }

        if (isNativeIn) {
          try {
            const wrappedAfter = BigInt((await contractCallView<string>(CONTRACTS.woct, 'balance_of', [address]).catch(() => '0')) ?? '0')
            const change = wrappedAfter - wrappedBefore
            if (change > 0n) {
              const { txHash: h } = await callContract(CONTRACTS.woct, 'withdraw', [change.toString()], '0', '5000')
              await pollReceipt(h, 'unwrap_change')
            }
          } catch (e) { console.warn('[swap] could not unwrap the change:', e) }
        }

        const xrec: SwapRecord = { hash: xoHash, timestamp: Date.now(), tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amtIn, amtOut, route: '1hop' }
        saveSwapHistory(address, xrec)
        addToast({ type: 'success', message: `${amtIn} ${tokenIn.symbol} to ${amtOut} ${tokenOut.symbol}`, txHash: xoHash })
        setAmtIn(''); setAmtOut(''); setLastEdited('in'); setQuoteStatus('idle'); setRouteType('none')
        return
      }

      if (routeType === '1hop' && lastEdited === 'in') {
        try {
          const fresh = await estimateAhead
          if (!fresh) throw new Error('no fresh quote arrived')
          const freshOut = BigInt(String(fresh[0]))
          const shownOut = toBaseUnits(amtOut, tokenOut.decimals)
          if (freshOut < bumpDown(shownOut, effectiveSlippage)) {
            const freshFmt = fromBaseUnits(freshOut, tokenOut.decimals)
            addToast({ type: 'error', message: `price moved: you would now get ~${freshFmt} ${tokenOut.symbol}. refresh the quote and try again.` })
            return
          }
          amtOutMin = bumpDown(freshOut, effectiveSlippage).toString()
        } catch (rq) {
          console.warn('[swap] re-quote failed, keeping shown-quote floor:', rq instanceof Error ? rq.message : rq)
        }
      }

      const useMultiExec = routeType === '1hop' && connectMethod === 'key'
      const useSwapHelper = routeType === '1hop' && isNativeOut && !!CONTRACTS.swaphelper

      addToast({ type: 'pending', message: 'swapping...' })

      const batched = connectMethod === 'key' &&
        (routeType === '1hop' || (routeType === '2hop' && !!CONTRACTS.multihop))
      if (isNativeIn && !batched) {
        const { txHash: wrapHash } = await callContract(CONTRACTS.woct, 'deposit', [], String(Math.round(Number(amtIn) * 1_000_000)), '5000')
        const wr = await pollReceipt(wrapHash, 'wrap')
        if (!wr?.success) throw new Error(`wrap failed: ${wr?.error ?? 'no receipt'}`)
      }

      const sqrtPriceLimitX96 = '0'
      const swapExecOut = (r: Awaited<ReturnType<typeof pollReceipt>>): string => {
        const evt = ((r?.events ?? []) as unknown as Array<{ event?: string; values?: unknown[] }>)
          .find(e => e.event === 'SwapExecuted')
        return evt?.values ? String(evt.values[5]) : '0'
      }

      let swapHash: string
      let swapR: Awaited<ReturnType<typeof pollReceipt>>

      if (routeType === '2hop' && tokenMid && route2Fees && CONTRACTS.multihop) {
        const mid = tokenMid
        const helper = CONTRACTS.multihop

        if (connectMethod === 'key') {
          const calls: MultiExecCall[] = []
          if (isNativeIn) calls.push({ address: CONTRACTS.woct, method: 'deposit', params: [], amount: amtInRaw })
          calls.push({ address: tIn.address, method: 'grant', params: [helper, amtInRaw] })
          calls.push({ address: helper, method: 'exact_input_double',
            params: [tIn.address, route2Fees.fee1, mid.address, route2Fees.fee2, tOut.address, address, deadline, amtInRaw, amtOutMin] })
          const submit = async () => {
            const pin = await getSessionPin('Enter your wallet PIN to authorize the swap')
            if (!pin) throw new Error('PIN required to swap')
            return submitMultiExec(calls, String(contractCallOu), pin)
          }
          try { swapHash = await submit() }
          catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (/\b403\b|PIN/i.test(msg)) { clearSessionPin(); swapHash = await submit() }
            else throw e
          }
        } else {
          const g = await callContract(tIn.address, 'grant', [helper, amtInRaw], '0', '5000')
          if (!(await pollReceipt(g.txHash, 'grant'))?.success) throw new Error('grant (multihop) failed')
          const r = await callContract(helper, 'exact_input_double',
            [tIn.address, route2Fees.fee1, mid.address, route2Fees.fee2, tOut.address, address, deadline, amtInRaw, amtOutMin], '0', String(contractCallOu))
          swapHash = r.txHash
        }
        swapR = await pollReceipt(swapHash, 'multihop')
        if (!swapR?.success) throw new Error(`2-hop (${tIn.symbol} to ${mid.symbol} to ${tOut.symbol}) failed: ${swapR?.error ?? 'no receipt'} | effort: ${swapR?.effort}`)
      } else if (routeType === '2hop' && tokenMid && route2Fees) {
        const mid = tokenMid

        const g1 = await callContract(tIn.address, 'grant', [router, amtInRaw], '0', '5000')
        if (!(await pollReceipt(g1.txHash, 'grant1'))?.success) throw new Error('grant (hop 1) failed')
        const h1 = await callContract(router, 'exact_input_single',
          [tIn.address, mid.address, route2Fees.fee1, address, deadline, amtInRaw, '0', sqrtPriceLimitX96], '0', String(contractCallOu))
        const h1r = await pollReceipt(h1.txHash, 'hop1')
        if (!h1r?.success) throw new Error(`hop 1 (${tIn.symbol} to ${mid.symbol}) failed: ${h1r?.error ?? 'no receipt'}`)
        const midAmtRaw = swapExecOut(h1r)
        if (midAmtRaw === '0') throw new Error('hop 1 produced no output')

        const g2 = await callContract(mid.address, 'grant', [router, midAmtRaw], '0', '5000')
        if (!(await pollReceipt(g2.txHash, 'grant2'))?.success) throw new Error('grant (hop 2) failed')
        const h2 = await callContract(router, 'exact_input_single',
          [mid.address, tOut.address, route2Fees.fee2, address, deadline, midAmtRaw, amtOutMin, sqrtPriceLimitX96], '0', String(contractCallOu))
        swapHash = h2.txHash
        swapR = await pollReceipt(h2.txHash, 'hop2')
        if (!swapR?.success) throw new Error(`hop 2 (${mid.symbol} to ${tOut.symbol}) failed: ${swapR?.error ?? 'no receipt'}`)
      } else if (useSwapHelper) {
        const helper = CONTRACTS.swaphelper
        if (connectMethod === 'key') {
          const calls: MultiExecCall[] = [
            { address: tIn.address, method: 'grant', params: [helper, amtInRaw] },
            { address: helper, method: 'swap_to_native', params: [tIn.address, fee, address, deadline, amtInRaw, amtOutMin] },
          ]
          const submit = async () => {
            const pin = await getSessionPin('Enter your wallet PIN to authorize the swap')
            if (!pin) throw new Error('PIN required to swap')
            return submitMultiExec(calls, String(contractCallOu), pin)
          }
          try { swapHash = await submit() }
          catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (/\b403\b|PIN/i.test(msg)) { clearSessionPin(); swapHash = await submit() }
            else throw e
          }
        } else {
          const g = await callContract(tIn.address, 'grant', [helper, amtInRaw], '0', '5000')
          if (!(await pollReceipt(g.txHash, 'grant'))?.success) throw new Error('grant failed')
          const r = await callContract(helper, 'swap_to_native',
            [tIn.address, fee, address, deadline, amtInRaw, amtOutMin], '0', String(contractCallOu))
          swapHash = r.txHash
        }
        swapR = await pollReceipt(swapHash, 'swap_to_native')
        if (!swapR?.success) throw new Error(`swap failed: ${swapR?.error ?? 'no receipt'} | effort: ${swapR?.effort}`)
      } else if (useMultiExec) {
        const calls: MultiExecCall[] = []
        if (isNativeIn) calls.push({ address: CONTRACTS.woct, method: 'deposit', params: [], amount: amtInRaw })
        calls.push({ address: tIn.address, method: 'grant', params: [router, amtInRaw] })

        calls.push({ address: router, method: 'exact_input_single',
          params: [tIn.address, tOut.address, fee, address, deadline, amtInRaw, amtOutMin, sqrtPriceLimitX96] })

        const submit = async () => {
          const pin = await getSessionPin('Enter your wallet PIN to authorize the swap')
          if (!pin) throw new Error('PIN required to swap')
          return submitMultiExec(calls, String(contractCallOu), pin)
        }
        try {
          swapHash = await submit()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/\b403\b|PIN/i.test(msg)) { clearSessionPin(); swapHash = await submit() }
          else throw e
        }
        swapR = await pollReceipt(swapHash, 'multi_exec_swap')
        if (!swapR?.success) throw new Error(`swap failed: ${swapR?.error ?? 'no receipt'} | effort: ${swapR?.effort}`)
      } else {
        const g = await callContract(tIn.address, 'grant', [router, amtInRaw], '0', '5000')
        if (!(await pollReceipt(g.txHash, 'grant'))?.success) throw new Error('grant failed')
        const r = await callContract(router, 'exact_input_single',
          [tIn.address, tOut.address, fee, address, deadline, amtInRaw, amtOutMin, sqrtPriceLimitX96], '0', String(contractCallOu))
        swapHash = r.txHash
        swapR = await pollReceipt(swapHash, 'router_swap')
        if (!swapR?.success) throw new Error(`swap failed: ${swapR?.error ?? 'no receipt'} | effort: ${swapR?.effort}`)
      }

      if (isNativeOut && !useSwapHelper) {
        let unwrapAmt = amtOutMin
        const evList = (swapR?.events ?? []) as unknown as Array<{ event?: string; values?: unknown[] }>
        const evSwap = evList.find(e => e.event === 'SwapExecuted')
        if (evSwap?.values) {
          const evAmtOut = BigInt(String(evSwap.values[5]))
          if (evAmtOut > 0n) unwrapAmt = evAmtOut.toString()
        }
        const { txHash: unwrapHash } = await callContract(CONTRACTS.woct, 'withdraw', [unwrapAmt], '0', '5000')
        const ur = await pollReceipt(unwrapHash, 'unwrap', 30000)
        if (!ur?.success) throw new Error(`unwrap failed: ${ur?.error ?? 'no receipt'}`)
      }

      const rec: SwapRecord = {
        hash:      swapHash,
        timestamp: Date.now(),
        tokenIn:   tokenIn.symbol,
        tokenOut:  tokenOut.symbol,
        amtIn,
        amtOut,
        route:     routeType === '2hop' ? '2hop' : '1hop',
        tokenMid:  routeType === '2hop' && tokenMid ? tokenMid.symbol : undefined,
      }
      saveSwapHistory(address, rec)

      addToast({ type: 'success', message: `${amtIn} ${tokenIn.symbol} to ${amtOut} ${tokenOut.symbol}`, txHash: swapHash })
      setAmtIn(''); setAmtOut(''); setQuoteStatus('idle'); setRouteType('none')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'swap failed'
      console.error('[swap] ERROR:', msg, e)
      addToast({ type: 'error', message: msg })
    } finally {
      setLoading(false)
      setBusy(false)
    }
  }

  const feeAmount = amtIn ? Number(amtIn) * fee / 1_000_000 : 0

  const publicCalls  = (tokenIn?.address === 'NATIVE' ? 1 : 0) + 2 * (routeType === '2hop' ? 2 : 1) + (tokenOut?.address === 'NATIVE' ? 1 : 0)
  const publicGasOct = publicCalls * (contractCallOu / 1e6)
  const displayOut   = amtOut

  const canSwap = connected && quoteStatus === 'ok' && !loading

  return (
    <div style={{
      minHeight: '100%', boxSizing: 'border-box',
      padding: '24px 32px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div className="swap-grid">
        <div style={{ display: 'contents' }}>

        <div className="ui-card" style={{ gridArea: '1 / 1', display: 'flex', flexDirection: 'column', minWidth: 0 }}>

          <div className="px-6 pt-5 pb-1 flex items-center justify-between">
            {tokenIn && tokenOut && quoteStatus === 'ok' && Number(amtIn) > 0 && Number(displayOut) > 0 ? (
              <span style={{ fontSize: 13, color: 'var(--oct-color-text-2)' }}>
                1 {tokenIn.symbol}{' '}
                <span style={{ color: 'var(--oct-color-muted)' }}>=</span>{' '}
                <span style={{ fontFamily: 'var(--oct-type-mono)', color: 'var(--oct-color-text)' }}>
                  {(Number(displayOut) / Number(amtIn)).toFixed(6)}
                </span>{' '}
                {tokenOut.symbol}
              </span>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--oct-color-muted)' }}>
                {tokenIn && tokenOut ? 'enter an amount' : 'choose a pair'}
              </span>
            )}
            <div className="flex items-center" style={{ gap: 8 }}>
              <button
                onClick={flip}
                disabled={!tokenIn || !tokenOut}
                title="swap the pair around"
                aria-label="swap the pair around"
                className="ui-icon"
                style={{ width: 30, height: 30, opacity: tokenIn && tokenOut ? 1 : .4 }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 4v13" /><path d="m4 14 3 3 3-3" />
                  <path d="M17 20V7" /><path d="m14 10 3-3 3 3" />
                </svg>
              </button>
              <button
                onClick={refreshQuote}
                disabled={quoteStatus === 'quoting'}
                title="refresh rate"
                aria-label="refresh rate"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 24, padding: 0, background: 'transparent',
                  border: '1px solid var(--oct-color-border)',
                  cursor: quoteStatus === 'quoting' ? 'default' : 'pointer',
                  color: 'var(--oct-color-muted)',
                }}
              >
                <svg className={quoteStatus === 'quoting' ? 'oct-spin' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
              <button
                onClick={() => setShowSettings(v => !v)}
                aria-label="trade settings"
                aria-pressed={showSettings}
                className="ui-icon"
                style={{ width: 30, height: 30, color: showSettings ? 'var(--oct-color-primary)' : undefined }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.72 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.72h.08A1.6 1.6 0 0 0 10.5 3.25V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.08a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
                </svg>
              </button>
            </div>
          </div>

          <div style={{
            height: showSettings ? settingsH : 0,
            overflow: 'hidden',
            opacity: showSettings ? 1 : 0,
            transition: 'height .3s cubic-bezier(.16,1,.3,1), opacity .22s ease',
          }}>
          <div ref={settingsRef}>
          <div className="px-6 py-3" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, auto)', gap: 18 }}>
            <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--oct-color-muted)', marginBottom: 7 }}>slippage</div>
            <div className="flex items-center" style={{ gap: 8 }}>
              <Segmented
                mono
                value={customSlip ? null : slippage}
                onChange={v => { setSlippage(v); setCustomSlip('') }}
                items={SLIPPAGE_OPTIONS.map(o => ({ value: o, label: `${o}%` }))}
              />
              <input
                value={customSlip}
                inputMode="decimal"
                onChange={e => {
                  const v = e.target.value.replace(',', '.')
                  if (v === '' || /^\d{0,3}(\.\d{0,2})?$/.test(v)) setCustomSlip(v)
                }}
                placeholder="custom"
                style={{
                  width: 62, minWidth: 0, height: 36, boxSizing: 'border-box',
                  fontSize: 12, fontFamily: 'var(--oct-type-mono)', textAlign: 'center',
                  background: 'var(--oct-color-surface)', border: 'none',
                  borderRadius: 'var(--r-md)', padding: '0 6px',
                  color: 'var(--oct-color-text)', outline: 'none',
                }}
              />
            </div>
            </div>

            <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--oct-color-muted)', marginBottom: 7 }}>fee tier</div>
            {routeType === '2hop' && route2Fees && tokenMid ? (
              <div style={{ fontSize: 13, fontFamily: 'var(--oct-type-mono)', color: 'var(--oct-color-muted)', paddingTop: 5 }}>
                auto {feeLabel(route2Fees.fee1)} + {feeLabel(route2Fees.fee2)} via {tokenMid.symbol}
              </div>
            ) : (
              <Segmented
                mono
                value={fee}
                onChange={v => setFee(v)}
                items={FEE_TIERS.map(f => {
                  const off = availableFees.length > 0 && !availableFees.includes(f.value)
                  return { value: f.value, label: f.label, disabled: off,
                           title: off ? 'no pool at this tier for this pair' : undefined }
                })}
              />
            )}
            </div>
          </div>
          </div>
          </div>

          <div className="ui-inset" style={{ margin: '10px 18px 0' }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--oct-color-muted)' }}>sell</span>
              {tokenIn ? (
                <div className="flex items-center gap-2" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                  <span className="font-mono">{tokenBalance(tokenIn)}</span>
                  <button
                    onClick={() => setAmtIn(formatBaseUnits(rawBalance(tokenIn) / 2n, tokenIn.decimals))}
                    className="ui-chip"
                  >50%</button>
                  <button
                    onClick={() => setAmtIn(formatBaseUnits(spendable(tokenIn), tokenIn.decimals))}
                    className="ui-chip"
                  >max</button>
                </div>
              ) : <span />}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px 6px' }}>
              <button
                onClick={() => setShowTokenModal('in')}
                className="ui-ghost whitespace-nowrap"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  fontSize: 15, fontWeight: 600, padding: '9px 16px', minWidth: 112, lineHeight: 1,
                }}
              >
                {tokenIn ? tokenIn.symbol : 'select'}
                <span style={{ color: 'var(--oct-color-muted)', marginLeft: 4 }} />
              </button>
              <input
                type="number"
                value={amtIn}
                onChange={e => { setAmtIn(e.target.value); setAmtOut(''); setLastEdited('in'); setQuoteStatus('idle'); setRouteType('none') }}
                placeholder="0.0"
                style={{
                  flex: 1, minWidth: 0, width: '100%', textAlign: 'right', fontSize: 30, fontWeight: 500,
                  color: 'var(--oct-color-text)', fontFamily: 'var(--oct-type-mono)',
                  background: 'transparent', border: 'none', outline: 'none',
                  boxShadow: 'none', padding: 0,
                }}
              />
            </div>
            <div style={{ textAlign: 'right', padding: '0 18px 16px', fontSize: 14, color: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}>
              {tokenUsd(tokenIn, amtIn) || '$0.00'}
            </div>
          </div>

          <div className="ui-inset" style={{ margin: '8px 18px 18px' }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--oct-color-muted)' }}>buy</span>
              {tokenOut && (
                <span style={{ fontSize: 14, color: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}>
                  {tokenBalance(tokenOut)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px 6px' }}>
              <button
                onClick={() => setShowTokenModal('out')}
                className="ui-ghost whitespace-nowrap"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  fontSize: 15, fontWeight: 600, padding: '9px 16px', minWidth: 112, lineHeight: 1,
                }}
              >
                {tokenOut ? tokenOut.symbol : 'select'}
                <span style={{ color: 'var(--oct-color-muted)', marginLeft: 4 }} />
              </button>
                <input
                  type="number"
                  value={amtOut}
                  onChange={e => { setAmtOut(e.target.value); setAmtIn(''); setLastEdited('out'); setQuoteStatus('idle'); setRouteType('none') }}
                  placeholder="0.0"
                  style={{
                    flex: 1, minWidth: 0, width: '100%', textAlign: 'right', fontSize: 30, fontWeight: 500,
                    color: 'var(--oct-color-text)', fontFamily: 'var(--oct-type-mono)',
                    background: 'transparent', border: 'none', outline: 'none',
                    boxShadow: 'none', padding: 0,
                  }}
                />
            </div>
            <div style={{ textAlign: 'right', padding: '0 18px 16px', fontSize: 14, color: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}>
              {quoteStatus === 'ok' ? (tokenUsd(tokenOut, displayOut) || '$0.00') : '$0.00'}
            </div>
            {quoteStatus === 'too_big' && maxHintIn != null && tokenIn && (
              <div style={{ textAlign: 'right', padding: '0 16px 12px', fontSize: 12, color: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}>
                max ~{maxHintIn >= 10 ? Math.round(maxHintIn).toLocaleString() : maxHintIn.toFixed(2)} {tokenIn.symbol} per swap
              </div>
            )}
          </div>

          {quoteStatus === 'ok' && (
            <div className="border-t border-border px-4 py-2 space-y-1">
              <div className="flex justify-between" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                <span>route</span>
                <span className="font-mono">
                  {routeType === '2hop' && tokenMid
                    ? `${poolToken(tokenIn!).symbol} to ${tokenMid.symbol} to ${poolToken(tokenOut!).symbol}`
                    : `${poolToken(tokenIn!).symbol} to ${poolToken(tokenOut!).symbol}`}
                </span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                <span>fee</span>
                <span className="font-mono">{routeType === '2hop' && route2Fees
                  ? `${feeLabel(route2Fees.fee1)} + ${feeLabel(route2Fees.fee2)}`
                  : `${feeLabel(fee)} · ${feeAmount.toFixed(6)} ${tokenIn?.symbol}`}</span>
              </div>
              {publicGasOct > 0 && (
                <div className="flex justify-between" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                  <span>network fee</span>
                  <span className="font-mono">~{publicGasOct.toFixed(3)} OCT · {publicCalls} tx</span>
                </div>
              )}
              {priceImpact > 0 && (
                <div className={`flex justify-between`} style={{
                  fontSize: 14,
                  color: priceImpact > 5
                    ? 'var(--oct-color-danger)'
                    : priceImpact > 1
                      ? 'var(--oct-color-warning)'
                      : 'var(--oct-color-muted)',
                }}>
                  <span>price impact</span>
                  <span className="font-mono">{priceImpact.toFixed(2)}%</span>
                </div>
              )}
              {lastEdited === 'out' ? (
                <div className="flex justify-between" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                  <span>max sent ({effectiveSlippage}% slippage)</span>
                  <span className="font-mono">{(Number(amtIn) * (1 + effectiveSlippage / 100)).toFixed(4)} {tokenIn?.symbol}</span>
                </div>
              ) : (
                <div className="flex justify-between" style={{ fontSize: 14, color: 'var(--oct-color-muted)' }}>
                  <span>min received ({effectiveSlippage}% slippage)</span>
                  <span className="font-mono">{(Number(displayOut) * (1 - effectiveSlippage / 100)).toFixed(4)} {tokenOut?.symbol}</span>
                </div>
              )}
            </div>
          )}
        </div>{}

        <button
          onClick={connected ? doSwap : openConnectModal}
          disabled={connected && !canSwap}
          className="ui-primary"
          style={{
            width: '100%',
            gridArea: '2 / 1',
            padding: '16px 0',
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 0,
            borderRadius: 'var(--r-lg)',
            cursor: connected && !canSwap ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--oct-type-ui)',
          }}
        >
          {!connected ? 'connect wallet' :
           loading ? 'swapping...' :
           quoteStatus === 'too_big' ? 'amount too large' :
           quoteStatus === 'no_liq' ? 'no liquidity in pool' :
           quoteStatus === 'disabled' ? 'swap temporarily unavailable' :
           'swap'}
        </button>

        </div>{}

        <aside style={{ gridArea: '1 / 2', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'grid', gap: 12 }}>
          <div className="bg-surface border border-border" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 14, color: 'var(--oct-color-muted)', fontWeight: 600 }}>OCT</span>
              <span style={{ fontSize: 13, color: 'var(--oct-color-text)', fontFamily: 'var(--oct-type-mono)' }}>
                {`$${octPrice.toFixed(4)}`}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, letterSpacing: '0.5px', color: 'var(--oct-color-muted)' }}>
              <span>24h change</span>{renderChange(octChange)}
            </div>
          </div>
          <div className="bg-surface border border-border" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 14, color: 'var(--oct-color-muted)', fontWeight: 600 }}>FACT</span>
              <span style={{ fontSize: 13, color: 'var(--oct-color-text)', fontFamily: 'var(--oct-type-mono)' }}>
                {`$${(impliedFactPrice || poolFactPrice).toFixed(6)}`}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, letterSpacing: '0.5px', color: 'var(--oct-color-muted)' }}>
              <span>24h change</span>{renderChange(factChange)}
            </div>
          </div>
          </div>

          <div className="ui-card-flat" style={{ padding: '6px 8px' }}>
            {topPools.length === 0 ? (
              <div style={{ padding: '12px 8px', fontSize: 13, color: 'var(--oct-color-muted)' }}>reading the chain…</div>
            ) : topPools.map(tp => (
              <button
                key={tp.address}
                onClick={() => { const a = tokenByAddress(tp.token0); const b = tokenByAddress(tp.token1); if (a && b) { setTokenIn(a); setTokenOut(b) } }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, padding: '9px 10px', background: 'transparent', border: 'none',
                  borderRadius: 'var(--r-sm)', cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--oct-color-surface)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--oct-color-text)' }}>
                  {symbolOf(tp.token0)} / {symbolOf(tp.token1)}
                </span>
                <span style={{ fontSize: 12, fontFamily: 'var(--oct-type-mono)', color: 'var(--oct-color-muted)' }}>
                  {(tp.fee / 10000).toFixed(2)}%
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>{}

      {showTokenModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setShowTokenModal(null)}
        >
          <div
            className="ui-card"
            style={{ minWidth: 380, width: 460, maxWidth: '92vw', boxShadow: 'var(--sh-lg)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-1 flex justify-between items-center">
              <span style={{ fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 600 }}>select token</span>
              <button onClick={() => setShowTokenModal(null)} style={{ fontSize: 14, color: 'var(--oct-color-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
            <div className="px-3 pt-3">
              <input
                autoFocus
                value={modalSearch}
                onChange={e => setModalSearch(e.target.value)}
                placeholder="search by name or address"
                className="w-full outline-none"
                style={{
                  fontSize: 13, padding: '10px 12px', border: 'none',
                  background: 'var(--oct-color-surface)', borderRadius: 'var(--r-md)',
                  color: 'var(--oct-color-text)',
                }}
              />
            </div>
            <div className="p-3 space-y-1">
              {knownTokens().filter(t => {
                const q = modalSearch.toLowerCase()
                return !q || t.symbol.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)
              }).map(t => (
                <button
                  key={t.address}
                  onClick={() => {
                    if (showTokenModal === 'in') setTokenIn(t)
                    else setTokenOut(t)
                    setShowTokenModal(null)
                    setModalSearch('')
                  }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left ui-row"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <TokenIcon symbol={t.symbol} address={t.address} size={28} style={{ flexShrink: 0 }} />
                    <div className="min-w-0">
                      <p style={{ fontSize: 15, color: 'var(--oct-color-text)', fontWeight: 500 }}>
                        {t.symbol}
                        {t.verified === false && duplicateSymbols().has(t.address)
                          ? <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, marginLeft: 6 }}>
                              same name, different address
                            </span>
                          : t.verified === false
                            ? <span style={{ fontSize: 11, color: 'var(--oct-color-warning)', marginLeft: 6 }}>unverified</span>
                            : null}
                      </p>
                      <p className="font-mono truncate" style={{ fontSize: 13, color: 'var(--oct-color-muted)' }}>
                        {t.address === 'NATIVE' ? 'native' : t.address}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p style={{ fontSize: 14, color: 'var(--oct-color-muted)', fontFamily: 'var(--oct-type-mono)' }}>{tokenBalance(t)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
