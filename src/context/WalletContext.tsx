import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { wallet, initWallet } from '../wallet'
import { submitCallTx, getBalance } from '../utils/rpc'
import { getOctra, octraAvailable, waitForOctra } from '../utils/walletOctra'

const WALLET_STORAGE_KEY = 'oct_wallet_session_v1'

interface StoredSession { method: 'key' | 'sdk'; address: string; viewPriv?: string }

export interface KnownWallet { address: string; label: string; viewPriv: string }
const KNOWN_KEY = 'oct_known_wallets'
function loadKnown(): KnownWallet[] {
  try { return JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]') } catch { return [] }
}
function saveKnown(list: KnownWallet[]) {
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify(list)) } catch {  }
}
export function shortLabel(addr: string): string {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : ''
}

function loadSession(): StoredSession | null {
  try { return JSON.parse(localStorage.getItem(WALLET_STORAGE_KEY) ?? 'null') }
  catch { return null }
}
function saveSession(s: StoredSession) {
  try { localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(s)) } catch {}
}
function clearSession() {
  try { localStorage.removeItem(WALLET_STORAGE_KEY) } catch {}
}

declare const __APP_BUILD__: string
const CONTRACTS_VER = __APP_BUILD__
try {
  if (localStorage.getItem('oct_contracts_ver') !== CONTRACTS_VER) {
    for (const k of ['oct_factory_addr', 'oct_fact_addr', 'oct_pool_addr', 'oct_woct_addr',
      'oct_router_addr', 'oct_quoter_addr', 'oct_multihop_addr', 'oct_swaphelper_addr',
      'oct_tokenmeta_addr', 'oct_oracle_addr',
      ]) localStorage.removeItem(k)
    localStorage.removeItem('oct_pools_v2')
    localStorage.removeItem('oct_pools_cache_v1')
    localStorage.removeItem('oct_pool_tokens')
    localStorage.removeItem('oct_extra_tokens')
    localStorage.setItem('oct_contracts_ver', CONTRACTS_VER)
  }
} catch {  }

function resolveContracts() {
  let factOverride = '', poolOverride = '', woctOverride = '', routerOverride = '', quoterOverride = '', factoryOverride = '', multihopOverride = '', swaphelperOverride = '', tokenMetaOverride = '', oracleOverride = ''
  try {
    factoryOverride = localStorage.getItem('oct_factory_addr') || ''
    factOverride    = localStorage.getItem('oct_fact_addr')    || ''
    poolOverride    = localStorage.getItem('oct_pool_addr')    || ''
    woctOverride    = localStorage.getItem('oct_woct_addr')    || ''
    routerOverride  = localStorage.getItem('oct_router_addr')  || ''
    quoterOverride  = localStorage.getItem('oct_quoter_addr')  || ''
    multihopOverride = localStorage.getItem('oct_multihop_addr') || ''
    swaphelperOverride = localStorage.getItem('oct_swaphelper_addr') || ''
    tokenMetaOverride = localStorage.getItem('oct_tokenmeta_addr') || ''
    oracleOverride = localStorage.getItem('oct_oracle_addr') || ''
  } catch {  }
  return {
    factory:         factoryOverride || 'octFVpfuNb45oK9oWnE4ezhtzfFYzU8ddqAsq5p1RzBbDJd',
    router:          routerOverride  || 'octDVbwa9T7Gs5uDExSKw3rCH4sRkwy8M2qixXJJCBVTLc8',
    quoter:          quoterOverride  || 'octAgXurs5zRbP88ASXNrKT5Evi7P4ozJNHFrS1YJHTRidf',
    multihop:        multihopOverride || 'octBF2q92ZHFE61CRKKgYQfoVGSbdy8yRsMebCcb6RQGR6n',
    swaphelper:      swaphelperOverride || 'oct2NP8nswgzWQ5Mt1ubRScuinyuK3fXdkAF8bEmKWTp6x7',
    pool:            poolOverride    || 'oct9dmE4kmoyeUzbKmk27GCgczGbv2MqKotDbmyvCAz182V',
    woct:            woctOverride    || 'oct4NZL1b4WoGoCtuNNyB6vtngmmvkfGHCYjkwgugX7AmsB',
    fact:            factOverride    || 'oct8mCmYaMFN7LUDJwti87G6dXEdJraswXTzU4UfQ7LTF2W',
    tokenMeta:       tokenMetaOverride || 'octFjuYgpjxWpqHxhXiDnDBR3guveGcET7TnsThby67Jmyf',
    oracle:          oracleOverride || 'octBcrSMH47GWzEMkcQsnTzVoUoukxJpC2kqqYwiUE8FQEf',
  }
}
export function spoofedAddresses(): string[] {
  const keys: Record<string, string> = {
    oct_factory_addr: 'factory', oct_router_addr: 'router', oct_quoter_addr: 'quoter',
    oct_multihop_addr: 'multihop', oct_swaphelper_addr: 'swaphelper', oct_pool_addr: 'pool',
    oct_woct_addr: 'woct', oct_fact_addr: 'FACT',
    oct_tokenmeta_addr: 'token meta', oct_oracle_addr: 'oracle',
  }
  const have: string[] = []
  try {
    for (const [ri, name] of Object.entries(keys)) if (localStorage.getItem(ri)) have.push(name)
  } catch {  }
  return have
}

type Contracts = ReturnType<typeof resolveContracts>
export const CONTRACTS: Contracts = new Proxy({} as Contracts, {
  get(_: Contracts, key: string | symbol) {
    if (typeof key === 'string') return resolveContracts()[key as keyof Contracts]
    return undefined
  },
})

type Param = string | number | boolean

interface WalletState {
  address: string
  balance: string
  connected: boolean
  extensionAvailable: boolean | null
  connectMethod: 'sdk' | 'key' | null
  _pk: string
  viewPriv: string
}

interface Toast {
  id: string
  type: 'pending' | 'success' | 'error'
  message: string
  txHash?: string
}

interface WalletContextType extends WalletState {
  showConnectModal: boolean
  openConnectModal: () => void
  closeConnectModal: () => void
  connectWithSDK: () => Promise<void>
  connectWithOctra: () => Promise<void>
  disconnect: () => Promise<void>
  refreshBalance: () => Promise<void>
  callContract: (contract: string, method: string, params: Param[], amount?: string, ou?: string) => Promise<{ txHash: string; success: boolean }>
  knownWallets: KnownWallet[]
  removeKnownWallet: (address: string) => void
  getSessionPin: (title: string) => Promise<string | null>
  clearSessionPin: () => void
  toasts: Toast[]
  addToast: (t: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
  busy: boolean
  setBusy: (v: boolean) => void
  walletSidebarOpen: boolean
  openWalletSidebar: () => void
  closeWalletSidebar: () => void
}

const WalletContext = createContext<WalletContextType | null>(null)

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({
    address: '', balance: '0', connected: false,
    extensionAvailable: null, connectMethod: null, _pk: '', viewPriv: '',
  })
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busy, setBusy] = useState(false)
  const [walletSidebarOpen, setWalletSidebarOpen] = useState(false)
  const [knownWallets, setKnownWallets] = useState<KnownWallet[]>(loadKnown)

  useEffect(() => {
    if (state.connectMethod !== 'key' || !state.address || !state.viewPriv) return
    setKnownWallets(prev => {
      const ex = prev.find(w => w.address === state.address)
      if (ex && ex.viewPriv === state.viewPriv) return prev
      const next = [...prev.filter(w => w.address !== state.address),
        { address: state.address, label: ex?.label ?? shortLabel(state.address), viewPriv: state.viewPriv }]
      saveKnown(next); return next
    })
  }, [state.connectMethod, state.address, state.viewPriv])

  useEffect(() => {
    const onAccount  = (e: { data: { newAddress: string } }) =>
      setState(s => ({ ...s, address: e.data.newAddress }))
    const onBalance  = (e: { data: { newBalance: { total: number } } }) =>
      setState(s => ({ ...s, balance: String(Math.round(e.data.newBalance.total * 1_000_000)) }))
    const onDisconnect = () => {
      clearSession()
      setState(s => ({ ...s, address: '', balance: '0', connected: false, connectMethod: null, _pk: '', viewPriv: '' }))
    }

    wallet.on('accountChanged', onAccount)
    wallet.on('balanceChanged', onBalance)
    wallet.on('disconnect',     onDisconnect)

    initWallet()
      .then(available => {
        setState(s => ({ ...s, extensionAvailable: available }))

        const stored = loadSession()
        if (!stored) return

        if (stored.method === 'key' && !octraAvailable()) {
          clearSession()
        } else if (stored.method === 'key') {
          getBalance(stored.address)
            .then(res => setState(s => ({
              ...s,
              address:       stored.address,
              balance:       String(Math.round(Number(res.balance) * 1_000_000) || 0),
              connected:     true,
              connectMethod: 'key',
              viewPriv:      stored.viewPriv ?? '',
            })))
            .catch(() => setState(s => ({
              ...s,
              address:       stored.address,
              balance:       '0',
              connected:     true,
              connectMethod: 'key',
              viewPriv:      stored.viewPriv ?? '',
            })))
        } else if (stored.method === 'sdk' && available) {
          wallet.connect({ requestPermissions: ['read_balance', 'send_transactions'] })
            .then(result => wallet.getBalance().then(bal => {
              setState(s => ({
                ...s,
                address:       result.address,
                balance:       String(Math.round(bal.total * 1_000_000)),
                connected:     true,
                connectMethod: 'sdk',
              }))
            }))
            .catch(() => clearSession())
        }
      })
      .catch(() => setState(s => ({ ...s, extensionAvailable: false })))

    return () => {
      try { wallet.off('accountChanged', onAccount)  } catch {  }
      try { wallet.off('balanceChanged', onBalance)  } catch {  }
      try { wallet.off('disconnect',     onDisconnect) } catch {  }
    }
  }, [])

  const openConnectModal  = useCallback(() => setShowConnectModal(true),  [])
  const closeConnectModal = useCallback(() => setShowConnectModal(false), [])

  const connectWithSDK = useCallback(async () => {
    if (!wallet.isReady()) {
      const available = await initWallet()
      if (!available) {
        setState(s => ({ ...s, extensionAvailable: false }))
        throw new Error('0xio extension not found, please install it first')
      }
      setState(s => ({ ...s, extensionAvailable: true }))
    }
    let result
    try {
      result = await wallet.connect({ requestPermissions: ['read_balance', 'send_transactions'] })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('No active wallet') || msg.includes('unlock') || msg.includes('locked')) {
        result = await wallet.connect({ requestPermissions: ['read_balance', 'send_transactions'] })
      } else throw e
    }
    let balanceRaw = '0'
    const cb = (result as unknown as { balance?: { total?: number } | string | number }).balance
    const fromConnect = (cb && typeof cb === 'object') ? Number(cb.total ?? 0) : Number(cb ?? 0)
    if (Number.isFinite(fromConnect)) balanceRaw = String(Math.round(fromConnect * 1_000_000) || 0)
    try {
      const bal = await Promise.race([
        wallet.getBalance(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('getBalance timeout')), 4000)),
      ])
      balanceRaw = String(Math.round(bal.total * 1_000_000))
    } catch {  }
    setState(s => ({
      ...s,
      address: result.address,
      balance: balanceRaw,
      connected: true,
      connectMethod: 'sdk',
    }))
    saveSession({ method: 'sdk', address: result.address })
    setShowConnectModal(false)
  }, [])

  const connectWithOctra = useCallback(async () => {
    const octra = await waitForOctra()
    if (!octra) throw new Error('Factory Wallet extension not found — install it and reload the page')
    const accounts = await octra.requestAccounts()
    const address = accounts?.[0]
    if (!address) throw new Error('Factory Wallet returned no account')
    let bal = '0'
    try { const b = await octra.getBalance(address); bal = String(Math.round(Number(b.balance) * 1_000_000) || 0) } catch {  }
    setState(s => ({ ...s, address, balance: bal, connected: true, connectMethod: 'key', _pk: '', viewPriv: '' }))
    saveSession({ method: 'key', address })
    setShowConnectModal(false)
  }, [])

  const disconnect = useCallback(async () => {
    if (state.connectMethod === 'sdk') {
      try { await wallet.disconnect() } catch {  }
    } else if (state.connectMethod === 'key') {
      try { await getOctra()?.disconnect?.() } catch {  }
    }
    clearSession()
    setState(s => ({ ...s, address: '', balance: '0', connected: false, connectMethod: null, _pk: '', viewPriv: '' }))
  }, [state.connectMethod])

  const refreshBalance = useCallback(async () => {
    if (!state.connected) return
    try {
      if (state.connectMethod === 'sdk') {
        const bal = await wallet.getBalance(true)
        setState(s => ({ ...s, balance: String(Math.round(bal.total * 1_000_000)) }))
      } else if (state.connectMethod === 'key') {
        const res = await getBalance(state.address)
        setState(s => ({ ...s, balance: String(Math.round(Number(res.balance) * 1_000_000) || 0) }))
      }
    } catch {  }
  }, [state.connected, state.connectMethod, state.address])

  const callContract = useCallback(async (
    contract: string,
    method: string,
    params: Param[],
    amount = '0',
    ou?: string,
  ): Promise<{ txHash: string; success: boolean }> => {
    if (state.connectMethod === 'key') {
      const hash = await submitCallTx({
        from: state.address,
        privateKey: state._pk,
        contract,
        method,
        params,
        amount: Number(amount) / 1_000_000,
        ou: ou ?? '5000',
      })
      return { txHash: hash, success: true }
    }
    const doCall = () => wallet.callContract({ contract, method, params, amount })
    const isTransient = (m: string) =>
      /determine nonce|network unreachable|network error|fetch failed|timed? ?out|ECONNREFUSED|ECONNRESET|50[234]|429/i.test(m)
    let lastErr: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await doCall()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('No active wallet') || msg.includes('unlock') || msg.includes('locked')) {
          await wallet.connect({ requestPermissions: ['read_balance', 'send_transactions'] })
          return await doCall()
        }
        if (isTransient(msg) && attempt < 3) {
          lastErr = e
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        throw e
      }
    }
    throw lastErr
  }, [state.connectMethod, state.address, state._pk])

  const removeKnownWallet = useCallback((addr: string) => {
    setKnownWallets(prev => { const next = prev.filter(w => w.address !== addr); saveKnown(next); return next })
  }, [])

  const getSessionPin = useCallback(async (_title: string): Promise<string | null> => 'extension', [])
  const clearSessionPin = useCallback(() => {  }, [])

  const addToast = useCallback((t: Omit<Toast, 'id'>): string => {
    const id = Math.random().toString(36).slice(2)
    setToasts(ts => {
      const base = t.type !== 'pending' ? ts.filter(x => x.type !== 'pending') : ts
      return [...base, { ...t, id }]
    })
    const duration = t.type === 'pending' ? 60000 : 20000
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), duration)
    return id
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(ts => ts.filter(t => t.id !== id))
  }, [])

  useEffect(() => {
    if (state.connected) {
      const t = setInterval(refreshBalance, 60_000)
      return () => clearInterval(t)
    }
  }, [state.connected, refreshBalance])

  return (
    <WalletContext.Provider value={{
      ...state,
      showConnectModal, openConnectModal, closeConnectModal,
      connectWithSDK, connectWithOctra,
      disconnect, refreshBalance, callContract,
      knownWallets, removeKnownWallet, getSessionPin, clearSessionPin,
      toasts, addToast, removeToast,
      busy, setBusy,
      walletSidebarOpen,
      openWalletSidebar:  () => setWalletSidebarOpen(true),
      closeWalletSidebar: () => setWalletSidebarOpen(false),
    }}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet outside WalletProvider')
  return ctx
}
