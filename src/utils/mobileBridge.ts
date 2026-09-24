
let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

function request(method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    try { window.parent.postMessage({ __fw: 'req', id, method, params }, '*') }
    catch (e) { waiting.delete(id); reject(e); return }
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('wallet request timed out')) }, 180_000)
  })
}

function installProvider() {
  const provider = {
    isFactoryWallet: true,
    request: (a: { method: string; params?: unknown[] }) => request(a.method, a.params ?? []),
    requestAccounts: () => request('octra_requestAccounts'),
    getAccounts: () => request('octra_accounts'),
    disconnect: () => request('octra_disconnect'),
    getBalance: (address: string) => request('octra_getBalance', [address]),
    privateBalance: () => request('octra_privateBalance'),
    sendTransfer: (to: string, oct: number) => request('octra_signAndSend', [{ kind: 'transfer', to, oct }]),
    call: (contract: string, method: string, params: (string | number)[], valueOct?: number) =>
      request('octra_signAndSend', [{ kind: 'call', contract, method, params, valueOct }]),
    multiExec: (calls: unknown[]) => request('octra_signAndSend', [{ kind: 'multiExec', calls }]),
    deploy: (bytecode: string, params: (string | number)[], ou?: string) =>
      request('octra_signAndSend', [{ kind: 'deploy', bytecode, params, ou }]),
  }
  const w = window as unknown as { octra?: unknown; factoryWallet?: unknown }
  w.octra = provider
  w.factoryWallet = provider
  window.dispatchEvent(new Event('octra#initialized'))
  window.dispatchEvent(new CustomEvent('octra:announceProvider', { detail: { info: { name: 'factory wallet', rdns: 'xyz.factory.wallet' }, provider } }))
}

export function installMobileBridge(): void {
  if (typeof window === 'undefined' || window.parent === window) return
  let installed = false
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { __fw?: string; id?: number; ok?: boolean; result?: unknown; error?: string } | null
    if (!d || typeof d !== 'object' || d.__fw == null) return
    if (e.source !== window.parent) return
    if (d.__fw === 'hello-ack') { if (!installed) { installed = true; installProvider() } return }
    if (d.__fw === 'res' && typeof d.id === 'number') {
      const p = waiting.get(d.id); if (!p) return
      waiting.delete(d.id)
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'wallet error'))
    }
  })
  const hello = () => { try { window.parent.postMessage({ __fw: 'hello' }, '*') } catch {  } }
  hello(); setTimeout(hello, 250); setTimeout(hello, 800); setTimeout(hello, 2000)
}
