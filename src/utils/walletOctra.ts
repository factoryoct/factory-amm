
export interface OctraProvider {
  requestAccounts(): Promise<string[]>
  getAccounts(): Promise<string[]>
  disconnect?(): Promise<boolean>
  getBalance(address: string): Promise<{ balance: string; nonce: number }>
  privateBalance?(): Promise<{ value: string | null }>
  sendTransfer(to: string, oct: number): Promise<{ hash: string }>
  call(contract: string, method: string, params: (string | number)[], valueOct?: number): Promise<{ hash: string }>
  multiExec(calls: { to: string; method: string; params: unknown[]; value: string }[]): Promise<{ hash: string }>
  signMessage?(message: string): Promise<string>
  publicKey?(): Promise<string>
  deploy?(bytecode: string, params: (string | number)[], ou?: string): Promise<{ hash: string; contractAddress: string }>
}

function isFactory(p: unknown): p is OctraProvider {
  const o = p as Partial<OctraProvider> | null
  return !!o && typeof o.requestAccounts === 'function' && typeof o.multiExec === 'function'
}

export function getOctra(): OctraProvider | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { factoryWallet?: unknown; octra?: unknown }
  if (isFactory(w.factoryWallet)) return w.factoryWallet
  if (isFactory(w.octra)) return w.octra
  return null
}

export function octraAvailable(): boolean {
  return getOctra() !== null
}

export function waitForOctra(timeoutMs = 4000): Promise<OctraProvider | null> {
  const now = getOctra()
  if (now) return Promise.resolve(now)
  return new Promise(resolve => {
    const started = Date.now()
    const tick = () => {
      const p = getOctra()
      if (p) { cleanup(); resolve(p); return }
      if (Date.now() - started >= timeoutMs) { cleanup(); resolve(null); return }
    }
    const id = setInterval(tick, 80)
    const onAnnounce = () => tick()
    window.addEventListener('octra#initialized', onAnnounce)
    window.addEventListener('factoryWallet#initialized', onAnnounce)
    function cleanup() {
      clearInterval(id)
      window.removeEventListener('octra#initialized', onAnnounce)
      window.removeEventListener('factoryWallet#initialized', onAnnounce)
    }
  })
}
