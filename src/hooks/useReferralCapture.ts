import { useEffect } from 'react'
import { useWallet } from '../context/WalletContext'
import { setReferral, setReferralByCode } from '../utils/points'

const PENDING_KEY = 'oct_pending_ref'
const isAddr = (s: string) => /^oct[1-9A-HJ-NP-Za-km-z]{20,}$/.test(s)
const isCode = (s: string) => /^[a-z2-9]{6,32}$/.test(s)

export function useReferralCapture(): void {
  const { address, connected } = useWallet()

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const ref = (url.searchParams.get('ref') || '').trim()
      if (ref && (isCode(ref) || isAddr(ref)) && !localStorage.getItem(PENDING_KEY)) {
        localStorage.setItem(PENDING_KEY, ref)
      }
      if (url.searchParams.has('ref')) {
        url.searchParams.delete('ref')
        window.history.replaceState({}, '', url.pathname + url.search + url.hash)
      }
    } catch {  }
  }, [])

  useEffect(() => {
    if (!connected || !address) return
    let pending: string | null = null
    try { pending = localStorage.getItem(PENDING_KEY) } catch {  }
    if (!pending) return
    if (pending !== address) {
      if (isAddr(pending)) setReferral(address, pending)
      else setReferralByCode(address, pending)
    }
    try { localStorage.removeItem(PENDING_KEY) } catch {  }
  }, [connected, address])
}
