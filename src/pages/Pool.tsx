import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { contractCallView, contractCallTuple, waitForReceipt, getOctPrice, getCodeHash, lastOctPrice } from '../utils/rpc'
import { POOL_CODE_HASHES } from '../config/poolHashes'
import { CONTRACTS, useWallet } from '../context/WalletContext'
import { feeToPercent, formatCompact } from '../utils/format'
import { priceToSqrtPriceX96, priceToTick, nearestUsableTick, sqrtPriceToPrice } from '../utils/math'
import TokenSelectModal from '../components/TokenSelectModal'
import { tokenSymbol, isKnownToken, tokenUsd, getToken, addLocalToken, onTokensChanged, type TokenInfo } from '../config/tokens'
import { withoutSpikes } from '../utils/prices'
import { getTokenPricesUsd } from '../utils/price'
import { useIsMobile } from '../hooks/useMediaQuery'
import PageHead, { Page } from '../components/PageHead'

const POOL_INDEXER_URL = (import.meta.env.VITE_POOL_INDEXER_URL as string | undefined) ?? ''

const FEE_TIERS = [
  { fee: 500,   label: '0.05%', ts: 10,  desc: 'best for stable pairs' },
  { fee: 3000,  label: '0.30%', ts: 60,  desc: 'best for most pairs' },
  { fee: 10000, label: '1.00%', ts: 200, desc: 'best for exotic pairs' },
]

const SPARK: { v: number }[] = []
const M = 'var(--oct-type-mono)'
const F = 'var(--oct-type-ui)'
const CACHE_KEY = 'oct_pools_v2'

interface PoolInfo {
  address: string
  token0: string; token1: string
  token0Symbol: string; token1Symbol: string
  fee: number; liquidity: string; sqrtPrice: string; tick: number
  tvl: number; volume24h: number; fees24h: number; apr: number
}

type SortKey = 'pool' | 'tvl' | 'volume24h' | 'fees24h' | 'apr'
const POOL_COLS: { label: string; key: SortKey | null }[] = [
  { label: 'pool',      key: 'pool'      },
  { label: 'tvl',       key: 'tvl'       },
  { label: '24h vol',   key: 'volume24h' },
  { label: '24h fees',  key: 'fees24h'   },
  { label: 'apr',       key: 'apr'       },
  { label: '',          key: null        },
]

function readCache(): PoolInfo[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const all = JSON.parse(raw) as PoolInfo[]
    const seen = new Set<string>()
    return all.filter(p => { if (seen.has(p.address)) return false; seen.add(p.address); return true })
  } catch { return [] }
}

function writeCache(pools: PoolInfo[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(pools)) } catch {  }
}

export default function Pool() {
  const { connected, address, openConnectModal, callContract, addToast } = useWallet()
  const isMobile                      = useIsMobile()
  const navigate                      = useNavigate()
  const cached                        = readCache()
  const [pools, setPools]             = useState<PoolInfo[]>(cached)
  const [loading, setLoading]         = useState(cached.length === 0)
  const [refreshing, setRefreshing]   = useState(false)
  const [search, setSearch]           = useState('')
  const [showCreate, setShowCreate]   = useState(false)
  const [cp0, setCp0]                 = useState(CONTRACTS.woct)
  const [cp1, setCp1]                 = useState(CONTRACTS.fact)
  const [cpFee, setCpFee]             = useState(3000)
  const [cpPrice, setCpPrice]         = useState('1.0')
  const [cpBusy, setCpBusy]           = useState(false)
  const [octPrice, setOctPrice]       = useState(lastOctPrice)
  const [series, setSeries]           = useState<{ tvl: number; vol: number; fees: number }[]>([])
  const [tokenModal, setTokenModal]   = useState<'cp0' | 'cp1' | null>(null)
  const [, setTokTick]                = useState(0)
  const [sort, setSort]               = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'tvl', dir: 'desc' })
  const didLoad                       = useRef(false)

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'pool' ? 'asc' : 'desc' })
  }

  useEffect(() => { getOctPrice().then(setOctPrice).catch(() => {  }) }, [])

  useEffect(() => onTokensChanged(() => setTokTick(t => t + 1)), [])

  function onPickToken(t: TokenInfo) {
    if (tokenModal === 'cp0') { if (t.address !== cp1) setCp0(t.address) }
    else if (tokenModal === 'cp1') { if (t.address !== cp0) setCp1(t.address) }
  }

  useEffect(() => {
    if (didLoad.current) return
    didLoad.current = true
    loadSeries()
    if (CONTRACTS.factory) loadPools()
    else setLoading(false)
  }, [])

  async function loadSeries() {
    if (!POOL_INDEXER_URL) return
    try {
      const res = await fetch(`${POOL_INDEXER_URL}/?series=1`)
      if (res.ok) setSeries(await res.json() as { tvl: number; vol: number; fees: number }[])
    } catch {  }
  }

  async function loadPools() {
    const hasCached = readCache().length > 0
    if (hasCached) setRefreshing(true)
    if (connected && address && POOL_INDEXER_URL) {
      fetch(`${POOL_INDEXER_URL}/sync?wallet=${address}`).catch(() => {  })
    }
    try {
      const countRaw = await contractCallView<string>(CONTRACTS.factory, 'get_pool_count', [])
      const count = Number(countRaw)
      if (count === 0) { setPools([]); writeCache([]); return }

      const indices = Array.from({ length: count }, (_, i) => count - 1 - i)
      const octPrice = await getOctPrice().catch(() => 0)
      const tokenPrices = await getTokenPricesUsd(CONTRACTS.factory, CONTRACTS.woct, octPrice, CONTRACTS.router).catch(() => ({} as Record<string, number>))

      const seen = new Set<string>()
      const merged = new Map<string, PoolInfo>(
        readCache().filter(p => p.tick > -887272 && p.tick < 887272).map(p => [p.address, p]))
      const fresh = new Map<string, PoolInfo>()

      const addrs = await Promise.all(indices.map(i =>
        contractCallView<string>(CONTRACTS.factory, 'get_pool_at', [i]).catch(() => '')))

      const unread = new Set<string>()

      await Promise.all(addrs.map(async (addr): Promise<void> => {
        if (!addr) return
        if (seen.has(addr)) return
        seen.add(addr)
        try {
          const [tokens, config, poolRouter, codeHash] = await Promise.all([
            contractCallTuple(addr, 'get_tokens', []),
            contractCallTuple(addr, 'get_config', []),
            contractCallView<string>(addr, 'get_router', []).catch(() => ''),
            getCodeHash(addr),
          ])
          const [t0, t1] = tokens
          if (!isKnownToken(t0) || !isKnownToken(t1)) return
          const [fee, , poolFactory] = config
          if (poolFactory !== CONTRACTS.factory) return
          if (poolRouter !== CONTRACTS.router) return
          if (!codeHash || !POOL_CODE_HASHES.has(codeHash)) return

          const [slot0, liq, b0, b1] = await Promise.all([
            contractCallTuple(addr, 'get_slot0', []),
            contractCallView<string>(addr, 'get_liquidity', []),
            contractCallView<string>(t0, 'balance_of', [addr]),
            contractCallView<string>(t1, 'balance_of', [addr]),
          ])
          const [sqrtP, tick] = slot0
          if (sqrtP === '0' || sqrtP === '') return
          const tickNum = Number(tick)
          if (tickNum <= -887272 || tickNum >= 887272) return

          let tvl = 0, volume24h = 0, fees24h = 0, apr = 0

          try {
            const poolPrice = sqrtPriceToPrice(BigInt(sqrtP), 6, 6)
            if (octPrice > 0 && poolPrice > 0) {
              const p0 = t0 === CONTRACTS.woct ? octPrice : (tokenPrices[t0] ?? 0)
              const p1 = t1 === CONTRACTS.woct ? octPrice : (tokenPrices[t1] ?? 0)
              tvl = (Number(b0) / 1e6) * p0 + (Number(b1) / 1e6) * p1

              if (POOL_INDEXER_URL) {
                try {
                  const res = await fetch(`${POOL_INDEXER_URL}?pool=${addr}`)
                  if (res.ok) {
                    const m = await res.json() as {
                      vol0: string; vol1: string; fees0: string; fees1: string; swaps: number
                    }
                    const v0 = Number(m.vol0) / 1e6, v1 = Number(m.vol1) / 1e6
                    volume24h = v0 * p0 + v1 * p1
                    fees24h   = volume24h * (Number(fee) / 1_000_000)
              if (tvl >= 1 && fees24h > 0) apr = Math.min((fees24h * 365 / tvl) * 100, 100_000)
                  }
                } catch {  }
              }
            }
          } catch {  }

          const info: PoolInfo = {
            address: addr,
            token0: t0, token1: t1,
            token0Symbol: tokenSymbol(t0),
            token1Symbol: tokenSymbol(t1),
            fee: Number(fee), liquidity: liq, sqrtPrice: sqrtP, tick: Number(tick),
            tvl, volume24h, fees24h, apr,
          }
          fresh.set(info.address, info)
          merged.set(info.address, info)
          setPools([...merged.values()])
        } catch {
          unread.add(addr)
        }
      }))
      const arr = [...fresh.values()]
      for (const addr of unread) {
        const was = merged.get(addr)
        if (was && !fresh.has(addr)) arr.push(was)
      }
      setPools(arr)
      writeCache(arr)
    } catch {  }
    finally { setLoading(false); setRefreshing(false) }
  }

  async function handleCreatePool() {
    if (!connected) { openConnectModal(); return }
    if (cp0 === cp1) { addToast({ type: 'error', message: 'token0 and token1 must differ' }); return }
    if (existingByFee(cpFee)) { addToast({ type: 'error', message: 'this fee tier already exists for the pair' }); return }

    for (const addr of [cp0, cp1]) {
      const tk = getToken(addr)
      if (tk && tk.decimals !== 6) {
        addToast({ type: 'error', message:
          `${tk.symbol} has ${tk.decimals} decimals; pools currently support 6-decimal tokens only` })
        return
      }
    }

    setCpBusy(true)
    try {
      const tier = FEE_TIERS.find(t => t.fee === cpFee)!
      const price = priceInfo.price ?? (parseFloat(cpPrice) || 1)
      const sqrtP = priceToSqrtPriceX96(price)
      const tick  = nearestUsableTick(priceToTick(price), tier.ts)

      addToast({ type: 'pending', message: 'creating pool...' })
      const { txHash: cHash } = await callContract(
        CONTRACTS.factory, 'create_pool',
        [cp0, cp1, cpFee, sqrtP.toString(), String(tick)], undefined, '3000000')

      const canonicalFor = async () => {
        try {
          const who = String(await contractCallView<string>(CONTRACTS.factory, 'get_canonical', [cp0, cp1, cpFee]))
          return (who && who !== '0' && who !== 'undefined') ? who : ''
        } catch { return '' }
      }
      const cr = await waitForReceipt(cHash, 240_000).catch(() => null)
      if (cr && !cr.success) throw new Error('create failed: ' + (cr.error ?? 'reverted'))
      let newPool = await canonicalFor()
      for (let i = 0; !newPool && i < 30; i++) {
        await new Promise(res => setTimeout(res, 3000))
        newPool = await canonicalFor()
      }
      if (!newPool) throw new Error('the network did not confirm pool creation')

      for (const addr of [cp0, cp1]) {
        const t = getToken(addr)
        if (t) addLocalToken(t)
      }

      addToast({ type: 'success', message: 'pool created. now add the starting liquidity' })
      setShowCreate(false)
      navigate('/pool/' + newPool)
    } catch (e: unknown) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setCpBusy(false)
    }
  }

  const totalsReady = pools.length > 0 && octPrice > 0
  const totalTVL  = pools.reduce((s, p) => s + p.tvl, 0)
  const totalVol  = pools.reduce((s, p) => s + p.volume24h, 0)
  const totalFees = pools.reduce((s, p) => s + p.fees24h, 0)

  const real = withoutSpikes(series.filter(s => s.tvl > 0), s => s.tvl)
  const tvlSpark  = real.length > 1 ? real.map(s => ({ v: s.tvl }))  : SPARK
  const volSpark  = real.length > 1 ? real.map(s => ({ v: s.vol }))  : SPARK
  const feesSpark = real.length > 1 ? real.map(s => ({ v: s.fees })) : SPARK
  const hasShape = (d: { v: number }[]) => d.length > 1 && d.some(x => x.v > 0)

  const filtered = (() => {
    const passing = pools.filter(p =>
      isKnownToken(p.token0) && isKnownToken(p.token1) &&
      Number(p.liquidity) > 0 &&
      (p.token0Symbol + '/' + p.token1Symbol).toLowerCase().includes(search.toLowerCase()))
    const best = new Map<string, PoolInfo>()
    for (const p of passing) {
      const pair = [p.token0, p.token1].sort().join('-') + ':' + p.fee
      const cur = best.get(pair)
      if (!cur || Number(p.liquidity) > Number(cur.liquidity)) best.set(pair, p)
    }
    const arr = [...best.values()]
    arr.sort((a, b) => {
      const cmp = sort.key === 'pool'
        ? (a.token0Symbol + '/' + a.token1Symbol).localeCompare(b.token0Symbol + '/' + b.token1Symbol)
        : (a[sort.key] as number) - (b[sort.key] as number)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  })()

  const existingByFee = (fee: number) => pools.find(p =>
    p.fee === fee && ((p.token0 === cp0 && p.token1 === cp1) || (p.token0 === cp1 && p.token1 === cp0)))

  const deepestForPair = (a: string, b: string) => {
    const matches = pools.filter(p => (p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a))
    if (!matches.length) return undefined
    return matches.reduce((best, p) => (Number(p.liquidity) > Number(best.liquidity) ? p : best))
  }

  const W = CONTRACTS.woct
  const octPriceOf = (tok: string): number | null => {
    if (tok === W) return 1
    const p = deepestForPair(W, tok)
    if (!p || !p.sqrtPrice || p.sqrtPrice === '0') return null
    const pr = sqrtPriceToPrice(BigInt(p.sqrtPrice), 6, 6)
    if (!(pr > 0)) return null
    return p.token0 === W ? 1 / pr : pr
  }

  const priceInfo: { price: number | null; source: 'existing' | 'cross' | 'reference' | 'manual' } = (() => {
    const ex = deepestForPair(cp0, cp1)
    if (ex && ex.sqrtPrice && ex.sqrtPrice !== '0') {
      const exP = sqrtPriceToPrice(BigInt(ex.sqrtPrice), 6, 6)
      const price = ex.token0 === cp0 ? exP : (exP > 0 ? 1 / exP : 0)
      return { price, source: 'existing' }
    }
    if (cp0 !== W && cp1 !== W) {
      const a = octPriceOf(cp0), b = octPriceOf(cp1)
      if (a && b && b > 0) return { price: a / b, source: 'cross' }
    }
    const u0 = tokenUsd(cp0, octPrice), u1 = tokenUsd(cp1, octPrice)
    if (u0 && u1 && u1 > 0) return { price: u0 / u1, source: 'reference' }
    return { price: null, source: 'manual' }
  })()

  const tierExists = !!existingByFee(cpFee)

  return (
    <Page>
      <PageHead title="liquidity" busy={refreshing || loading} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 22 }}>
        {[
          { label: 'TVL',        value: '$' + formatCompact(totalTVL),  data: tvlSpark  },
          { label: '24h volume', value: '$' + formatCompact(totalVol),  data: volSpark  },
          { label: '24h fees',   value: '$' + formatCompact(totalFees), data: feesSpark },
        ].map(c => (
          <div key={c.label} className="ui-card-flat" style={{ padding: '18px 20px 12px' }}>
            <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', marginBottom: 6 }}>{c.label}</div>
            {totalsReady ? (
              <div style={{ fontFamily: M, fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', color: 'var(--oct-color-text)', marginBottom: 8 }}>{c.value}</div>
            ) : (
              <div style={{
                height: 26, width: 110, marginBottom: 8, borderRadius: 8,
                background: 'var(--oct-color-surface)',
              }} />
            )}
            {!hasShape(c.data) ? (
              <div style={{
                height: 44, display: 'flex', alignItems: 'center',
                fontFamily: F, fontSize: 12, color: 'var(--oct-color-faint)',
              }}>no history yet</div>
            ) : (
            <ResponsiveContainer width="100%" height={44}>
              <AreaChart data={c.data} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  isAnimationActive={false}
                  cursor={{ stroke: 'var(--oct-color-faint)', strokeWidth: 1 }}
                  labelFormatter={() => ''}
                  formatter={(val: number | string) => ['$' + formatCompact(Number(val)), c.label]}
                  contentStyle={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-md)', borderRadius: 10, padding: '5px 10px' }}
                  itemStyle={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-text)' }}
                  labelStyle={{ display: 'none' }}
                />
                <Area type="monotone" dataKey="v" stroke="var(--oct-color-primary)" fill="var(--oct-color-primary)" fillOpacity={0.14} dot={false} strokeWidth={1.6} isAnimationActive={false} activeDot={{ r: 3, fill: 'var(--oct-color-primary)', stroke: '#fff', strokeWidth: 1 }} />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <input
          placeholder="search pools..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1, fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)',
            background: 'var(--oct-color-bg)', border: 'none',
            boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-md)',
            height: 42, padding: '0 16px', outline: 'none', boxSizing: 'border-box',
          }}
        />
        <button
          onClick={() => setShowCreate(v => !v)}
          style={{
            fontFamily: F, fontSize: 14, fontWeight: 600,
            color: 'var(--oct-color-action-ink)', background: showCreate ? 'var(--oct-color-action-deep)' : 'var(--oct-color-action)',
            border: 'none', padding: '0 22px', height: 42, alignSelf: 'stretch',
            borderRadius: 'var(--r-md)', boxShadow: '0 6px 16px -10px rgba(23,25,31,.55)',
            cursor: 'pointer', letterSpacing: 0, whiteSpace: 'nowrap',
          }}
        >
          {showCreate ? 'cancel' : '+ create pool'}
        </button>
      </div>

      {showCreate && (
        <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: 20, marginBottom: 12 }}>
          <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 16 }}>
            create new pool
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            {([['token 0', cp0, cp1, 'cp0'], ['token 1', cp1, cp0, 'cp1']] as const).map(([label, addr, other, side]) => {
              const t = getToken(addr)
              return (
                <div key={side}>
                  <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>{label}</div>
                  <button onClick={() => setTokenModal(side)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '8px 10px', cursor: 'pointer' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t ? t.symbol : (addr ? addr.slice(0, 6) + '…' : 'select')}
                        {t?.verified === false ? <span style={{ color: 'var(--oct-color-warning)' }}> · unverified</span> : null}
                      </span>
                    </span>
                    <span style={{ color: 'var(--oct-color-muted)' }} aria-hidden>▾</span>
                  </button>
                  {other === addr && <div style={{ fontFamily: F, fontSize: 12, color: '#b4534b', marginTop: 4 }}>pick a different token</div>}
                </div>
              )
            })}
          </div>

          <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 8 }}>
            fee tier, the % you earn on every trade
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 18 }}>
            {FEE_TIERS.map(t => {
              const ex = existingByFee(t.fee)
              const selected = cpFee === t.fee
              const totalPairTvl = FEE_TIERS.reduce((s, x) => s + (existingByFee(x.fee)?.tvl ?? 0), 0)
              const share = ex && totalPairTvl > 0 ? (ex.tvl / totalPairTvl) * 100 : null
              return (
                <button key={t.fee} onClick={() => setCpFee(t.fee)}
                  style={{
                    textAlign: 'left', cursor: 'pointer',
                    background: selected ? 'var(--oct-color-border)' : 'var(--oct-color-surface-soft)',
                    border: selected ? '2px solid var(--oct-color-primary)' : '1px solid #e8e9ec',
                    padding: selected ? '11px 13px' : '12px 14px',
                  }}>
                  <div style={{ fontFamily: M, fontSize: 16, color: 'var(--oct-color-text)', marginBottom: 4 }}>{t.label}</div>
                  <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', marginBottom: 8, lineHeight: 1.3 }}>{t.desc}</div>
                  <div style={{ fontFamily: M, fontSize: 12, color: ex ? 'var(--oct-color-primary)' : 'var(--oct-color-faint)' }}>
                    {ex ? '$' + formatCompact(ex.tvl) + ' TVL' : 'not created'}
                  </div>
                  {share !== null && (
                    <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-faint)', marginTop: 2 }}>
                      {share.toFixed(share < 1 ? 3 : 1)}% of liquidity
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>
              initial price ({tokenSymbol(cp1)} per {tokenSymbol(cp0)})
            </div>
            {priceInfo.source === 'manual' ? (
              <>
                <input type="number" value={cpPrice} onChange={e => setCpPrice(e.target.value)} placeholder="1.0"
                  style={{ width: '100%', fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '6px 8px', boxSizing: 'border-box', outline: 'none' }} />
                <div style={{ fontFamily: F, fontSize: 12, color: '#b0742a', marginTop: 6 }}>
                  no price exists for this token yet, you are bootstrapping it. set it carefully.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontFamily: M, fontSize: 16, color: 'var(--oct-color-text)', background: 'var(--oct-color-border)', border: '1px solid #e8e9ec', padding: '8px 10px' }}>
                  {priceInfo.price !== null ? priceInfo.price.toPrecision(6) : 'n/a'}
                </div>
                <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', marginTop: 6 }}>
                  {priceInfo.source === 'existing'
                    ? 'set automatically from the existing pool price.'
                    : priceInfo.source === 'cross'
                      ? `derived via OCT from the ${tokenSymbol(cp0)}/OCT and ${tokenSymbol(cp1)}/OCT pools.`
                      : 'set automatically from known market prices.'}
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
            {!tierExists && (
              <div style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', marginRight: 'auto' }}>
                a pool without liquidity is not tradable and is not listed. you will be taken
                straight to the deposit step.
              </div>
            )}
            {tierExists && (
              <Link to={`/pool/${existingByFee(cpFee)!.address}`} style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-primary)', textDecoration: 'none' }}>
                this fee tier already exists, add liquidity instead
              </Link>
            )}
            <button
              onClick={handleCreatePool}
              disabled={cpBusy || tierExists}
              style={{
                fontFamily: F, fontSize: 15, fontWeight: 600,
                color: 'var(--oct-color-action-ink)',
                background: (cpBusy || tierExists) ? 'var(--oct-color-action-off)' : 'var(--oct-color-action)',
                border: 'none', padding: '8px 28px', borderRadius: 'var(--r-md)',
                cursor: (cpBusy || tierExists) ? 'not-allowed' : 'pointer',
                letterSpacing: '0.3px',
              }}
            >
              {cpBusy ? 'deploying...' : 'create pool'}
            </button>
          </div>
        </div>
      )}

      <TokenSelectModal
        open={tokenModal !== null}
        onClose={() => setTokenModal(null)}
        onSelect={onPickToken}
        exclude={tokenModal === 'cp0' ? cp1 : cp0}
      />

      <div className={isMobile ? '' : 'm-scroll'} style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
        {!isMobile && (
        <div className="pool-grid" style={{
          display: 'grid',
          padding: '14px 20px',
          borderBottom: '1px solid var(--oct-color-border)',
          background: 'transparent',
        }}>
          {POOL_COLS.map((col, i) => {
            const active = sort.key === col.key
            return (
              <span
                key={i}
                onClick={col.key ? () => toggleSort(col.key!) : undefined}
                style={{
                  fontFamily: F, fontSize: 13, color: active ? 'var(--oct-color-primary)' : 'var(--oct-color-muted)',
                  fontWeight: active ? 700 : 400,
                  textTransform: 'uppercase', letterSpacing: '0.8px',
                  textAlign: i > 0 ? 'right' as const : 'left' as const,
                  cursor: col.key ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                {col.label}
              </span>
            )
          })}
        </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 16px', fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)' }}>
            loading pools...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 16px', fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)' }}>
            {pools.length === 0 ? 'no pools found' : 'no matching pools'}
          </div>
        ) : (
          filtered.map(pool => isMobile ? (
            <Link key={pool.address} to={`/pool/${pool.address}`} style={{ display: 'block', padding: '14px 16px', borderBottom: '1px solid #e8e9ec', textDecoration: 'none', background: 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-text)' }}>{pool.token0Symbol}/{pool.token1Symbol}</span>
                <span style={{ fontFamily: F, fontSize: 12, color: 'var(--oct-color-muted)', whiteSpace: 'nowrap' }}>
                  {feeToPercent(pool.fee)}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 8, columnGap: 16 }}>
                {([['tvl', '$' + formatCompact(pool.tvl)], ['24h vol', '$' + formatCompact(pool.volume24h)], ['24h fees', '$' + formatCompact(pool.fees24h)], ['apr', pool.apr > 0 ? pool.apr.toFixed(2) + '%' : '0%']] as const).map(([l, v], i) => (
                  <div key={i} style={{ flex: '0 0 calc(50% - 8px)', display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                    <span style={{ fontFamily: F, color: 'var(--oct-color-muted)' }}>{l}</span>
                    <span style={{ fontFamily: M, color: l === 'apr' && pool.apr > 0 ? 'var(--oct-color-success)' : 'var(--oct-color-text)' }}>{v}</span>
                  </div>
                ))}
              </div>
            </Link>
          ) : (
            <Link
              key={pool.address}
              to={`/pool/${pool.address}`}
              className="pool-grid"
              style={{
                display: 'grid',
                padding: '16px 20px',
                borderBottom: '1px solid var(--oct-color-border)',
                textDecoration: 'none',
                alignItems: 'center',
                background: 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--oct-color-surface)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="12" height="10" viewBox="0 0 12 10" style={{ color: 'var(--oct-color-faint)', flexShrink: 0 }}>
                  <rect x="0" y="6" width="2.5" height="4" fill="currentColor"/>
                  <rect x="3.5" y="3" width="2.5" height="7" fill="currentColor"/>
                  <rect x="7" y="1" width="2.5" height="9" fill="currentColor"/>
                  <rect x="10" y="4" width="2" height="6" fill="currentColor"/>
                </svg>
                <div>
                  <span style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-text)' }}>
                    {pool.token0Symbol}/{pool.token1Symbol}
                  </span>
                  <span style={{
                    marginLeft: 9, fontFamily: F, fontSize: 12.5,
                    color: 'var(--oct-color-muted)', whiteSpace: 'nowrap',
                  }}>
                    {feeToPercent(pool.fee)}
                  </span>
                </div>
              </div>

              <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', textAlign: 'right' }}>
                ${formatCompact(pool.tvl)}
              </span>
              <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', textAlign: 'right' }}>
                ${formatCompact(pool.volume24h)}
              </span>
              <span style={{ fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', textAlign: 'right' }}>
                ${formatCompact(pool.fees24h)}
              </span>
              <span style={{
                fontFamily: M, fontSize: 14, textAlign: 'right',
                color: pool.apr > 0 ? 'var(--oct-color-success)' : 'var(--oct-color-muted)',
              }}>
                {pool.apr > 0 ? pool.apr.toFixed(2) + '%' : '0%'}
              </span>
            </Link>
          ))
        )}
      </div>
    </Page>
  )
}
