import { useState, type ReactNode } from 'react'
import { useWallet, CONTRACTS } from '../context/WalletContext'
import { compileAml, submitDeploy, waitForReceipt, contractCallTuple, SEC_PER_EPOCH } from '../utils/rpc'
import { addLocalToken } from '../config/tokens'

const F = 'var(--oct-type-ui)'
const M = 'var(--oct-type-mono)'

const FACTORY_KEY = 'oct_factory_addr'
const FACT_KEY    = 'oct_fact_addr'
const WOCT_KEY    = 'oct_woct_addr'
const POOL_KEY    = 'oct_pool_addr'
const ROUTER_KEY  = 'oct_router_addr'
const QUOTER_KEY  = 'oct_quoter_addr'
const FAUCET_KEY  = 'oct_faucet_addr'

type Status = 'idle' | 'pending' | 'ok' | 'err'

export default function Admin() {
  const { connected, address, openConnectModal, addToast, callContract } = useWallet()

  const [ttSym,    setTtSym]    = useState('TEST')
  const [ttSupply, setTtSupply] = useState('1000000')
  const [ttStatus, setTtStatus] = useState<Status>('idle')
  const [ttLog,    setTtLog]    = useState<string[]>([])
  const [demoAddr, setDemoAddr] = useState('')

  const [pfPool,    setPfPool]    = useState('')
  const [pfDenom,   setPfDenom]   = useState('6')
  const [pfRecip,   setPfRecip]   = useState('')
  const [pfStatus,  setPfStatus]  = useState<Status>('idle')
  const [pfLog,     setPfLog]     = useState<string[]>([])

  const [lrPool,   setLrPool]   = useState('')
  const [lrStatus, setLrStatus] = useState<Status>('idle')
  const [lrLog,    setLrLog]    = useState<string[]>([])

  const [mhAddr,   setMhAddr]   = useState(localStorage.getItem('oct_multihop_addr') || '')
  const [mhStatus, setMhStatus] = useState<Status>('idle')
  const [mhLog,    setMhLog]    = useState<string[]>([])
  const [shAddr,   setShAddr]   = useState(localStorage.getItem('oct_swaphelper_addr') || '')
  const [shStatus, setShStatus] = useState<Status>('idle')
  const [shLog,    setShLog]    = useState<string[]>([])

  const [deployAllStatus, setDeployAllStatus] = useState<Status>('idle')
  const [deployAllLog,    setDeployAllLog]    = useState<string[]>([])

  const [mintAmt,    setMintAmt]    = useState('1000000')
  const [mintTo,     setMintTo]     = useState('')
  const [mintStatus, setMintStatus] = useState<Status>('idle')
  const [mintLog,    setMintLog]    = useState<string[]>([])

  const [addrs, setAddrs] = useState({
    factory: localStorage.getItem(FACTORY_KEY) || '',
    woct:    localStorage.getItem(WOCT_KEY)    || '',
    fact:    localStorage.getItem(FACT_KEY)    || '',
    pool:    localStorage.getItem(POOL_KEY)    || '',
    router:  localStorage.getItem(ROUTER_KEY)  || '',
    quoter:  localStorage.getItem(QUOTER_KEY)  || '',
  })

  const [faucetAddr,   setFaucetAddr]   = useState(localStorage.getItem(FAUCET_KEY) || '')
  const [octAmt,       setOctAmt]       = useState('5')
  const [faucetAmt,    setFaucetAmt]    = useState('100')
  const [cooldownHrs,  setCooldownHrs]  = useState('24')
  const [fundOct,      setFundOct]      = useState('50')
  const [fundAmt,      setFundAmt]      = useState('100000')
  const [faucetStatus, setFaucetStatus] = useState<Status>('idle')
  const [faucetLog,    setFaucetLog]    = useState<string[]>([])
  const [allowAddr,    setAllowAddr]    = useState('')
  function flog(msg: string) { setFaucetLog(l => [...l, msg]) }

  function alog(msg: string)  { setDeployAllLog(l => [...l, msg]) }
  function mlog(msg: string) { setMintLog(l => [...l, msg]) }

  async function deployContract(amlFile: string, args: unknown[]): Promise<string> {
    const source = await fetch(`/${amlFile}`, { cache: 'no-store' }).then(r => r.text())
    const { bytecode } = await compileAml(source)
    const { hash, contractAddress: direct } = await submitDeploy('', '', bytecode, args)
    const receipt = await waitForReceipt(hash, 60_000)
    if (!receipt.success) throw new Error(`${amlFile} deploy failed: ${receipt.error ?? 'unknown'}`)
    const raw = receipt as unknown as Record<string, unknown>
    const addr = direct || String(receipt.result ?? raw['contract_address'] ?? raw['address'] ?? raw['new_address'] ?? '')
    if (!addr || addr === 'undefined') throw new Error(`could not get address for ${amlFile}`)
    return addr
  }

  function save(key: string, val: string, field: keyof typeof addrs) {
    localStorage.setItem(key, val)
    setAddrs(a => ({ ...a, [field]: val }))
  }

  async function deployAll() {
    if (!connected) { openConnectModal(); return }
    setDeployAllStatus('pending')
    setDeployAllLog([])
    try {
      alog('▶ deploying Factory...')
      const factory = await deployContract('factory.aml', [])
      alog(`✓ Factory: ${factory}`)
      save(FACTORY_KEY, factory, 'factory')

      alog('▶ deploying WOCT...')
      const woct = await deployContract('woct.aml', [])
      alog(`✓ WOCT: ${woct}`)
      save(WOCT_KEY, woct, 'woct')

      alog('▶ deploying FACT...')
      const fact = await deployContract('fact.aml', [])
      alog(`✓ FACT: ${fact}`)
      save(FACT_KEY, fact, 'fact')

      alog('▶ deploying Quoter...')
      const quoter = await deployContract('quoter.aml', [factory])
      alog(`✓ Quoter: ${quoter}`)
      save(QUOTER_KEY, quoter, 'quoter')

      alog('▶ deploying Router...')
      const router = await deployContract('router.aml', [factory, quoter])
      alog(`✓ Router: ${router}`)
      save(ROUTER_KEY, router, 'router')

      localStorage.removeItem('oct_pools_v2')
      alog('')
      alog('✅ core deployed. now create the FACT/OCT pool from the Pool page (it sets its own price).')
      setDeployAllStatus('ok')
      addToast({ type: 'success', message: 'core contracts deployed!' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alog('❌ ' + msg)
      setDeployAllStatus('err')
      addToast({ type: 'error', message: msg })
    }
  }

  async function mintFact() {
    if (!connected) { openConnectModal(); return }
    const fact = localStorage.getItem(FACT_KEY) || CONTRACTS.fact
    const to = mintTo.trim() || address
    const amtRaw = String(Math.round(Number(mintAmt) * 1_000_000))
    setMintStatus('pending')
    setMintLog([])
    try {
      mlog(`minting ${mintAmt} FACT to ${to}...`)
      const { txHash } = await callContract(fact, 'mint', [to, amtRaw], '0', '5000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error('mint failed: ' + (r.error ?? ''))
      mlog(`✓ tx: ${txHash}`)
      mlog(`minted ${mintAmt} FACT to ${to}`)
      setMintStatus('ok')
      addToast({ type: 'success', message: `minted ${mintAmt} FACT` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      mlog('❌ ' + msg)
      setMintStatus('err')
      addToast({ type: 'error', message: msg })
    }
  }

  const pfValid = (p: string) => p.startsWith('oct') && p.length === 47
  async function readProtocolFee() {
    const pool = pfPool.trim()
    if (!pfValid(pool)) { setPfLog(['enter a valid pool address']); setPfStatus('err'); return }
    setPfStatus('pending'); setPfLog([])
    const log = (m: string) => setPfLog(l => [...l, m])
    try {
      const slot0 = await contractCallTuple(pool, 'get_slot0', [])
      const denom = Number(slot0[2] ?? '0')
      const fees  = await contractCallTuple(pool, 'get_protocol_fees', [])
      log(`fee_protocol = ${denom} ${denom > 0 ? `(~${(100 / denom).toFixed(1)}% of swap fees → treasury)` : '(off)'}`)
      log(`accrued: ${(Number(fees[0] || '0') / 1e6).toFixed(6)} token0 + ${(Number(fees[1] || '0') / 1e6).toFixed(6)} token1`)
      setPfStatus('ok')
    } catch (e) { log('error: ' + (e instanceof Error ? e.message : String(e))); setPfStatus('err') }
  }
  async function setProtocolFee() {
    if (!connected) { openConnectModal(); return }
    const pool = pfPool.trim()
    if (!pfValid(pool)) { setPfLog(['enter a valid pool address']); setPfStatus('err'); return }
    const denom = Math.round(Number(pfDenom))
    if (!(denom >= 0 && denom <= 10)) { setPfLog(['denominator must be 0 (off) to 10']); setPfStatus('err'); return }
    setPfStatus('pending'); setPfLog([])
    const log = (m: string) => setPfLog(l => [...l, m])
    try {
      log(`setting fee_protocol=${denom} on ${pool.slice(0, 10)}… (via factory, owner-only)…`)
      const { txHash } = await callContract(CONTRACTS.factory, 'set_pool_fee_protocol', [pool, String(denom)], '0', '5000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error(r.error ?? 'reverted')
      log(denom === 0 ? '✓ protocol fee turned OFF' : `✓ ~${(100 / denom).toFixed(1)}% of swap fees now go to the treasury`)
      setPfStatus('ok')
    } catch (e) { log('error: ' + (e instanceof Error ? e.message : String(e))); setPfStatus('err') }
  }
  async function collectProtocol() {
    if (!connected) { openConnectModal(); return }
    const pool = pfPool.trim()
    if (!pfValid(pool)) { setPfLog(['enter a valid pool address']); setPfStatus('err'); return }
    const recip = pfRecip.trim() || address
    setPfStatus('pending'); setPfLog([])
    const log = (m: string) => setPfLog(l => [...l, m])
    try {
      log(`sweeping protocol fees → ${recip.slice(0, 10)}…`)
      const { txHash } = await callContract(CONTRACTS.factory, 'collect_pool_protocol', [pool, recip], '0', '6000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error(r.error ?? 'reverted')
      log('✓ collected to treasury: ' + txHash.slice(0, 16) + '…')
      setPfStatus('ok')
    } catch (e) { log('error: ' + (e instanceof Error ? e.message : String(e))); setPfStatus('err') }
  }

  async function deployFaucet() {
    if (!connected) { openConnectModal(); return }
    const fact = localStorage.getItem(FACT_KEY) || CONTRACTS.fact
    const octRaw   = String(Math.round(Number(octAmt) * 1_000_000))
    const factRaw  = String(Math.round(Number(faucetAmt) * 1_000_000))
    const cooldown = String(Math.max(1, Math.round(Number(cooldownHrs) * 3600 / SEC_PER_EPOCH)))
    setFaucetStatus('pending'); setFaucetLog([])
    try {
      flog(`▶ deploying Faucet (token=${fact.slice(0, 10)}…, ${octAmt} OCT + ${faucetAmt} FACT per claim, every ${cooldownHrs}h ≈ ${cooldown} epochs)…`)
      const addr = await deployContract('faucet.aml', [fact, octRaw, factRaw, cooldown])
      localStorage.setItem(FAUCET_KEY, addr)
      setFaucetAddr(addr)
      flog(`✅ faucet deployed: ${addr}`)
      flog('→ fund it with OCT + FACT below, then approve wallets')
      setFaucetStatus('ok')
      addToast({ type: 'success', message: 'faucet deployed' })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      flog('❌ ' + m); setFaucetStatus('err'); addToast({ type: 'error', message: m })
    }
  }

  async function fundFaucet() {
    if (!connected) { openConnectModal(); return }
    const faucet = localStorage.getItem(FAUCET_KEY) || faucetAddr
    if (!faucet) { addToast({ type: 'error', message: 'deploy faucet first' }); return }
    const fact = localStorage.getItem(FACT_KEY) || CONTRACTS.fact
    const amtRaw = String(Math.round(Number(fundAmt) * 1_000_000))
    setFaucetStatus('pending')
    try {
      flog(`▶ minting ${fundAmt} FACT into faucet ${faucet.slice(0, 10)}…`)
      const { txHash } = await callContract(fact, 'mint', [faucet, amtRaw], '0', '5000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error('fund failed: ' + (r.error ?? ''))
      flog(`✅ faucet funded with ${fundAmt} FACT`)
      setFaucetStatus('ok')
      addToast({ type: 'success', message: 'faucet funded (FACT)' })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      flog('❌ ' + m); setFaucetStatus('err'); addToast({ type: 'error', message: m })
    }
  }

  async function fundFaucetOct() {
    if (!connected) { openConnectModal(); return }
    const faucet = localStorage.getItem(FAUCET_KEY) || faucetAddr
    if (!faucet) { addToast({ type: 'error', message: 'deploy faucet first' }); return }
    const octRaw = String(Math.round(Number(fundOct) * 1_000_000))
    setFaucetStatus('pending')
    try {
      flog(`▶ sending ${fundOct} OCT into faucet ${faucet.slice(0, 10)}…`)
      const { txHash } = await callContract(faucet, 'fund_oct', [], octRaw, '50000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error('fund failed: ' + (r.error ?? ''))
      flog(`✅ faucet funded with ${fundOct} OCT`)
      setFaucetStatus('ok')
      addToast({ type: 'success', message: 'faucet funded (OCT)' })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      flog('❌ ' + m); setFaucetStatus('err'); addToast({ type: 'error', message: m })
    }
  }

  async function allowWallet() {
    if (!connected) { openConnectModal(); return }
    const faucet = localStorage.getItem(FAUCET_KEY) || faucetAddr
    if (!faucet) { addToast({ type: 'error', message: 'deploy faucet first' }); return }
    const w = allowAddr.trim()
    if (!w) { addToast({ type: 'error', message: 'enter a wallet address' }); return }
    try {
      addToast({ type: 'pending', message: `allowing ${w.slice(0, 8)}…` })
      const { txHash } = await callContract(faucet, 'allow', [w], '0', '5000')
      const r = await waitForReceipt(txHash, 30_000)
      if (!r.success) throw new Error('allow failed: ' + (r.error ?? ''))
      addToast({ type: 'success', message: 'wallet allowed' })
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const addrList = [
    { label: 'Factory', val: addrs.factory || CONTRACTS.factory },
    { label: 'WOCT',    val: addrs.woct    || CONTRACTS.woct },
    { label: 'FACT',    val: addrs.fact    || CONTRACTS.fact },
    { label: 'Pool',    val: addrs.pool    || CONTRACTS.pool },
    { label: 'Quoter',  val: addrs.quoter  || CONTRACTS.quoter },
    { label: 'Router',  val: addrs.router  || CONTRACTS.router },
    { label: 'Faucet',  val: faucetAddr },
  ]

  async function deployMultiHop() {
    if (!connected) { openConnectModal(); return }
    setMhStatus('pending'); setMhLog([])
    const log = (m: string) => setMhLog(l => [...l, m])
    try {
      const router = CONTRACTS.router
      if (!router) throw new Error('no router address configured')
      log(`deploying multihop.aml (router ${router.slice(0, 12)}…)…`)
      const addr = await deployContract('multihop.aml', [router])
      localStorage.setItem('oct_multihop_addr', addr)
      setMhAddr(addr)
      log('✓ MultiHop: ' + addr)
      log('saved — the swap UI now routes 2-hop swaps atomically through this helper.')
      setMhStatus('ok')
    } catch (e) {
      log('error: ' + (e instanceof Error ? e.message : String(e)))
      setMhStatus('err')
    }
  }

  async function deploySwapHelper() {
    if (!connected) { openConnectModal(); return }
    setShStatus('pending'); setShLog([])
    const log = (m: string) => setShLog(l => [...l, m])
    try {
      const router = CONTRACTS.router, woct = CONTRACTS.woct
      if (!router || !woct) throw new Error('no router/woct address configured')
      log(`deploying swaphelper.aml (router ${router.slice(0, 10)}…, woct ${woct.slice(0, 10)}…)…`)
      const addr = await deployContract('swaphelper.aml', [router, woct])
      localStorage.setItem('oct_swaphelper_addr', addr)
      setShAddr(addr)
      log('✓ SwapHelper: ' + addr)
      log('saved — token→OCT swaps now unwrap atomically through this helper.')
      setShStatus('ok')
    } catch (e) {
      log('error: ' + (e instanceof Error ? e.message : String(e)))
      setShStatus('err')
    }
  }

  async function linkRouter() {
    if (!connected) { openConnectModal(); return }
    const pool = lrPool.trim()
    if (!(pool.startsWith('oct') && pool.length === 47)) { setLrLog(['enter a valid pool address']); setLrStatus('err'); return }
    setLrStatus('pending'); setLrLog([])
    try {
      const { txHash } = await callContract(CONTRACTS.factory, 'set_pool_router', [pool, CONTRACTS.router])
      setLrLog([`✓ router linked: ${txHash.slice(0, 16)}…`, 'add liquidity should work now'])
      setLrStatus('ok')
    } catch (e) {
      setLrLog(['error: ' + (e instanceof Error ? e.message : String(e))])
      setLrStatus('err')
    }
  }

  async function deployTestToken() {
    if (!connected) { openConnectModal(); return }
    const sym = (ttSym.trim().toUpperCase() || 'TEST').slice(0, 8)
    const supply = Math.round(Number(ttSupply) || 0)
    if (supply <= 0) { setTtLog(['enter a supply greater than 0']); setTtStatus('err'); return }
    setTtStatus('pending'); setTtLog([])
    const log = (m: string) => setTtLog(l => [...l, m])
    try {
      log('deploying token contract (ocs01.aml — self-describing)…')
      const addr = await deployContract('ocs01.aml', [sym, sym + ' Token', 6])
      log('✓ token: ' + addr)
      log(`minting ${supply} ${sym} to you…`)
      const { txHash } = await callContract(addr, 'mint', [address, String(supply * 1_000_000)], '0', '5000')
      log('✓ mint tx: ' + txHash.slice(0, 16) + '…')
      addLocalToken({ address: addr, symbol: sym, name: sym + ' Token', decimals: 6 })
      log(`✓ added ${sym} to the token list — it now appears in create-pool selectors`)
      setTtStatus('ok')
    } catch (e) {
      log('error: ' + (e instanceof Error ? e.message : String(e)))
      setTtStatus('err')
    }
  }

  async function deployDemoToken() {
    if (!connected) { openConnectModal(); return }
    const sym = (ttSym.trim().toUpperCase() || 'DEMO').slice(0, 8)
    const supply = Math.round(Number(ttSupply) || 0)
    if (supply <= 0) { setTtLog(['enter a supply greater than 0']); setTtStatus('err'); return }
    setTtStatus('pending'); setTtLog([]); setDemoAddr('')
    const log = (m: string) => setTtLog(l => [...l, m])
    try {
      log('deploying demo token (ocs01.aml — self-describing, on-chain symbol)…')
      const addr = await deployContract('ocs01.aml', [sym, sym + ' Token', 6])
      log('✓ token: ' + addr)
      log(`minting ${supply} ${sym} to you…`)
      const { txHash } = await callContract(addr, 'mint', [address, String(supply * 1_000_000)], '0', '5000')
      log('✓ mint tx: ' + txHash.slice(0, 16) + '…')
      setDemoAddr(addr)
      log('NOT added to the list — paste the address into create-pool; its name resolves on-chain (no typing)')
      setTtStatus('ok')
    } catch (e) {
      log('error: ' + (e instanceof Error ? e.message : String(e)))
      setTtStatus('err')
    }
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '48px 40px' }}>
      <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 24 }}>
        admin
      </div>

      <Section title="deploy everything">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          deploys the core contracts from scratch: factory, WOCT, FACT, quoter, router.
          addresses are saved automatically. create pools afterwards from the pool page
          (each pool sets its own price).
        </p>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Btn onClick={deployAll} disabled={!connected || deployAllStatus === 'pending'}>
            {deployAllStatus === 'pending' ? 'deploying...' : 'deploy all'}
          </Btn>
          {!connected && <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>connect wallet first</span>}
        </div>
        <Log lines={deployAllLog} />
      </Section>

      <Section title="mint FACT">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          Mints FACT to an address (your own by default). Only the admin who deployed FACT can mint.
          To top up a relayer wallet for staking, enter its address.
        </p>
        <Row label="to (address)">
          <input value={mintTo} onChange={e => setMintTo(e.target.value)} placeholder={`${address.slice(0, 10)}… (this wallet)`}
            style={{ width: '100%', maxWidth: 460, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
        </Row>
        <Row label="amount">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" value={mintAmt} onChange={e => setMintAmt(e.target.value)}
              style={{ width: 120, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>FACT</span>
          </div>
        </Row>
        <div style={{ marginTop: 12 }}>
          <Btn onClick={mintFact} disabled={!connected || mintStatus === 'pending'}>
            {mintStatus === 'pending' ? 'minting...' : 'mint FACT'}
          </Btn>
        </div>
        <Log lines={mintLog} />
      </Section>

      <Section title="protocol fee (revenue)">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          the protocol's cut of swap fees. <b>fee_protocol</b> is a denominator: 0 = off, else 1/N of every
          swap's fee is diverted from LPs to the treasury (6 ≈ 16.7%, 10 = 10%). owner-only, applied per pool
          via the factory. it accrues inside the pool; sweep it to any treasury address. new swaps only.
        </p>
        <Row label="pool">
          <input value={pfPool} onChange={e => setPfPool(e.target.value)} placeholder="oct… pool address"
            style={{ width: '100%', maxWidth: 460, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
        </Row>
        <Row label="fee_protocol">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" value={pfDenom} onChange={e => setPfDenom(e.target.value)}
              style={{ width: 80, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>0 = off, 4-10 (1/N of fees)</span>
          </div>
        </Row>
        <Row label="treasury">
          <input value={pfRecip} onChange={e => setPfRecip(e.target.value)} placeholder={`${address.slice(0, 10)}… (this wallet)`}
            style={{ width: '100%', maxWidth: 460, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
        </Row>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={readProtocolFee} disabled={pfStatus === 'pending'}>read</Btn>
          <Btn onClick={setProtocolFee} disabled={!connected || pfStatus === 'pending'}>set protocol fee</Btn>
          <Btn onClick={collectProtocol} disabled={!connected || pfStatus === 'pending'}>collect to treasury</Btn>
        </div>
        <Log lines={pfLog} />
      </Section>

      <Section title="deploy multihop helper (atomic 2-hop swaps)">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          lets the swap UI run a 2-hop route (a pair with no direct pool, e.g. FACT to TEST through a hub) as a
          single atomic transaction instead of two. removes the risk of a failed second leg leaving you holding
          the intermediate hub token. the user grants this helper once; it grants the router internally per leg.
          constructor uses the current router. until deployed, the UI falls back to the legacy two-transaction route.
        </p>
        {mhAddr && (
          <Row label="address">
            <code style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-text)', wordBreak: 'break-all' }}>{mhAddr}</code>
          </Row>
        )}
        <div style={{ marginTop: 12 }}>
          <Btn onClick={deployMultiHop} disabled={!connected || mhStatus === 'pending'}>
            {mhStatus === 'pending' ? 'deploying…' : (mhAddr ? 'redeploy multihop' : 'deploy multihop')}
          </Btn>
        </div>
        <Log lines={mhLog} />
      </Section>

      <Section title="deploy swap helper (atomic token to OCT)">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          lets a token to OCT swap run as one atomic call (swap to WOCT then unwrap to native OCT inside the
          contract) instead of 3 separate transactions. helps both wallet modes: a 0xio user grants this helper
          and calls it (2 txs, no PIN); a webcli user bundles the grant + call into one multi_exec tx.
          constructor uses the current router and WOCT. until deployed, the UI falls back to swap-then-unwrap.
        </p>
        {shAddr && (
          <Row label="address">
            <code style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-text)', wordBreak: 'break-all' }}>{shAddr}</code>
          </Row>
        )}
        <div style={{ marginTop: 12 }}>
          <Btn onClick={deploySwapHelper} disabled={!connected || shStatus === 'pending'}>
            {shStatus === 'pending' ? 'deploying…' : (shAddr ? 'redeploy swap helper' : 'deploy swap helper')}
          </Btn>
        </div>
        <Log lines={shLog} />
      </Section>

      <Section title="link router to pool">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          links the router to an existing pool (required for add-liquidity/swap). use this to repair a
          pool created before the router was linked automatically. owner-only.
        </p>
        <Row label="pool">
          <input value={lrPool} onChange={e => setLrPool(e.target.value)} placeholder="oct… pool address"
            style={{ width: '100%', maxWidth: 460, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
        </Row>
        <div style={{ marginTop: 12 }}>
          <Btn onClick={linkRouter} disabled={!connected || lrStatus === 'pending'}>
            {lrStatus === 'pending' ? 'linking…' : 'link router'}
          </Btn>
        </div>
        <Log lines={lrLog} />
      </Section>

      <Section title="deploy test token">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          deploys a fresh OCS-01 token, mints the supply to you, and adds it to the token list so it
          shows up in the create-pool selectors. use it to test a new pool and a private swap on it.
        </p>
        <Row label="symbol">
          <input value={ttSym} onChange={e => setTtSym(e.target.value)}
            style={{ width: 120, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
        </Row>
        <Row label="supply">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" value={ttSupply} onChange={e => setTtSupply(e.target.value)}
              style={{ width: 160, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>whole tokens</span>
          </div>
        </Row>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={deployTestToken} disabled={!connected || ttStatus === 'pending'}>
            {ttStatus === 'pending' ? 'deploying…' : 'deploy test token'}
          </Btn>
          <Btn onClick={deployDemoToken} disabled={!connected || ttStatus === 'pending'}>
            {ttStatus === 'pending' ? 'deploying…' : 'deploy demo (no auto-add)'}
          </Btn>
        </div>
        {demoAddr && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)' }}>
            <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>
              demo token address (paste into create-pool import)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', wordBreak: 'break-all', flex: 1 }}>{demoAddr}</code>
              <Btn onClick={() => { try { navigator.clipboard.writeText(demoAddr) } catch {  } }}>copy</Btn>
            </div>
          </div>
        )}
        <Log lines={ttLog} />
      </Section>

      <Section title="early access">
        <p style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-primary-deep)', margin: '0 0 16px' }}>
          deploy the faucet (on-chain allowlist), fund it with OCT + FACT, then allow wallets
          directly. <code style={{ fontFamily: M, fontSize: 13 }}>allow()</code> runs on-chain;
          only approved wallets can claim and enter the app.
        </p>

        <Row label="per claim">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input type="number" value={octAmt} onChange={e => setOctAmt(e.target.value)}
              style={{ width: 80, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>OCT</span>
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>+</span>
            <input type="number" value={faucetAmt} onChange={e => setFaucetAmt(e.target.value)}
              style={{ width: 90, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>FACT</span>
          </div>
        </Row>
        <Row label="cooldown">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" value={cooldownHrs} onChange={e => setCooldownHrs(e.target.value)}
              style={{ width: 80, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
            <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>hours between claims (per wallet)</span>
          </div>
        </Row>
        <div style={{ marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={deployFaucet} disabled={!connected || faucetStatus === 'pending'}>
            {faucetStatus === 'pending' ? 'working…' : faucetAddr ? 'redeploy faucet' : 'deploy faucet'}
          </Btn>
        </div>

        {faucetAddr ? (
          <div style={{ marginTop: 14 }}>
            <Row label="fund OCT">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" value={fundOct} onChange={e => setFundOct(e.target.value)}
                  style={{ width: 120, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
                <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>OCT to faucet</span>
                <Btn onClick={fundFaucetOct} disabled={!connected || faucetStatus === 'pending'}>send OCT</Btn>
              </div>
            </Row>
            <Row label="fund FACT">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" value={fundAmt} onChange={e => setFundAmt(e.target.value)}
                  style={{ width: 120, fontFamily: M, fontSize: 14, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
                <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)' }}>FACT to faucet</span>
                <Btn onClick={fundFaucet} disabled={!connected || faucetStatus === 'pending'}>mint FACT</Btn>
              </div>
            </Row>
          </div>
        ) : null}
        <Log lines={faucetLog} />

        {faucetAddr ? (
          <div style={{ marginTop: 14 }}>
            <Row label="allow wallet">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input value={allowAddr} onChange={e => setAllowAddr(e.target.value)} placeholder="oct… (e.g. your own wallet)"
                  style={{ width: 280, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-surface)', border: 'none', borderRadius: 'var(--r-md)', padding: '5px 8px', outline: 'none' }} />
                <Btn onClick={allowWallet} disabled={!connected || faucetStatus === 'pending'}>allow</Btn>
              </div>
            </Row>
          </div>
        ) : null}
      </Section>

      <Section title="contract addresses">
        {addrList.map(({ label, val }) => val ? (
          <Row key={label} label={label}>
            <code style={{ fontFamily: M, fontSize: 12, wordBreak: 'break-all', color: 'var(--oct-color-text)' }}>{val}</code>
          </Row>
        ) : null)}
      </Section>
    </div>
  )
}

function Log({ lines }: { lines: string[] }) {
  if (!lines.length) return null
  return (
    <pre style={{
      marginTop: 12, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)',
      background: 'var(--oct-color-border)', border: '1px solid #e8e9ec',
      padding: '10px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      maxHeight: 300, overflowY: 'auto',
    }}>
      {lines.join('\n')}
    </pre>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)', padding: 20, marginBottom: 16 }}>
      <div style={{ fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 14 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}>
      <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-muted)', minWidth: 80, paddingTop: 1 }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  )
}

function Btn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: F, fontSize: 15, fontWeight: 600,
        color: '#ffffff',
        background: disabled ? 'var(--oct-color-muted)' : 'var(--oct-color-primary)',
        border: 'none', padding: '7px 20px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        letterSpacing: '0.3px',
      }}
    >
      {children}
    </button>
  )
}
