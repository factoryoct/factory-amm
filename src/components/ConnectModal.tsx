import { useState, useEffect } from 'react'
import { useWallet } from '../context/WalletContext'
import { octraAvailable, waitForOctra } from '../utils/walletOctra'

const ZEROXIO_STORE = 'https://chromewebstore.google.com/detail/0xio-wallet/anknhjilldkeelailocijnfibefmepcc'
const FACTORY_WALLET_REPO = 'https://github.com/factoryoct/factory-wallet'

export default function ConnectModal() {
  const {
    extensionAvailable,
    showConnectModal,
    closeConnectModal,
    connectWithSDK,
    connectWithOctra,
  } = useWallet()

  const [loading, setLoading] = useState<'' | 'octra' | 'sdk'>('')
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState('')

  const [hasOctra, setHasOctra] = useState(octraAvailable())
  useEffect(() => {
    if (!showConnectModal || hasOctra) return
    let alive = true
    void waitForOctra().then(p => { if (alive && p) setHasOctra(true) })
    return () => { alive = false }
  }, [showConnectModal, hasOctra])

  if (!showConnectModal) return null

  const handleClose = () => { closeConnectModal(); setError('') }

  const handleOctra = async () => {
    setLoading('octra'); setError('')
    try { await connectWithOctra() }
    catch (e) { setError(e instanceof Error ? e.message : 'connection failed') }
    finally { setLoading('') }
  }

  const handleSDK = async () => {
    setLoading('sdk'); setError('')
    try { await connectWithSDK() }
    catch (e) { setError(e instanceof Error ? e.message : 'connection failed') }
    finally { setLoading('') }
  }

  const handleRetryDetect = async () => {
    setRetrying(true); setError('')
    try { await connectWithSDK() }
    catch (e) {
      setError(
        e instanceof Error && e.message.includes('not found')
          ? 'extension still not detected, make sure it is enabled for this page and reload'
          : e instanceof Error ? e.message : 'retry failed'
      )
    } finally { setRetrying(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 2000 }}>
      <div className="bg-surface border border-border w-80 overflow-hidden">
        <div className="bg-panel px-4 py-2.5 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold text-ink">connect wallet</span>
          <button onClick={handleClose} className="text-muted hover:text-ink text-xs">✕</button>
        </div>

        <div className="p-4 space-y-3">

          {hasOctra ? (
            <button
              onClick={handleOctra}
              disabled={loading !== ''}
              className="w-full flex items-center justify-between px-3 py-2.5 border border-accent bg-accent/5 text-xs text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{loading === 'octra' ? 'connecting...' : 'connect factory wallet'}</span>
              <span className="text-[10px] uppercase tracking-wide bg-accent text-white px-1.5 py-0.5" style={{ borderRadius: 6 }}>{loading === 'octra' ? '···' : 'recommended'}</span>
            </button>
          ) : (
            <div className="px-3 py-2.5 border border-accent bg-accent/5 text-xs text-accent leading-relaxed">
              <span className="font-semibold">factory wallet</span> <span className="text-[10px] uppercase tracking-wide bg-accent text-white px-1.5 py-0.5" style={{ borderRadius: 6 }}>recommended</span>
              <div className="text-muted mt-1">not detected. install &amp; enable the extension, then reload this page.</div>
            </div>
          )}

          <a href={FACTORY_WALLET_REPO} target="_blank" rel="noreferrer" className="block text-center text-[11px] text-muted hover:text-accent">
            {hasOctra ? 'get factory wallet on github' : 'download factory wallet on github'}
          </a>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {extensionAvailable === null ? (
            <div className="flex items-center justify-between px-3 py-2.5 border border-border text-xs text-muted">
              <span>detecting 0xio extension...</span>
              <span className="animate-pulse">···</span>
            </div>
          ) : extensionAvailable === false ? (
            <div className="flex items-center justify-between px-3 py-2 bg-bg border border-border text-xs text-muted">
              <span>0xio not detected</span>
              <a href={ZEROXIO_STORE} target="_blank" rel="noreferrer" className="text-accent hover:underline">install</a>
            </div>
          ) : (
            <>
              <button
                onClick={handleSDK}
                disabled={loading !== ''}
                className="w-full flex items-center justify-between px-3 py-2.5 border border-border text-xs text-muted hover:text-ink hover:border-muted transition-colors disabled:opacity-50"
              >
                <span>{loading === 'sdk' ? 'connecting...' : 'connect with 0xio wallet'}</span>
                <span>{loading === 'sdk' ? '···' : ''}</span>
              </button>
              <p className="text-[10px] text-muted leading-snug mt-1.5 px-0.5">
                note: with 0xio some features may not work and errors are possible. use factory wallet for full support.
              </p>
            </>
          )}

          {extensionAvailable === false && !hasOctra && (
            <button onClick={handleRetryDetect} disabled={retrying} className="w-full text-xs text-accent hover:underline disabled:opacity-50">
              {retrying ? 'checking...' : 'retry detection'}
            </button>
          )}

          {error && <p className="text-xs text-danger px-1">{error}</p>}
        </div>
      </div>
    </div>
  )
}
