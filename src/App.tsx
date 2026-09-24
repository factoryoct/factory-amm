import { useEffect, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { WalletProvider, spoofedAddresses } from './context/WalletContext'
import { refreshTokensFromPools, ensureCompatProbed } from './config/tokens'
import Sidebar from './components/Sidebar'
import TopNav from './components/TopNav'
import Toast from './components/Toast'
import ConnectModal from './components/ConnectModal'
import WalletSidebar from './components/WalletSidebar'
import ReferralCapture from './components/ReferralCapture'
import { useIsMobile } from './hooks/useMediaQuery'
import { netState } from './utils/network'
import Swap from './pages/Swap'
import PriceTicker from './components/PriceTicker'

const Pool         = lazy(() => import('./pages/Pool'))
const AddLiquidity = lazy(() => import('./pages/AddLiquidity'))
const MyPositions  = lazy(() => import('./pages/MyPositions'))
const Leaderboard  = lazy(() => import('./pages/Leaderboard'))
const Protocol     = lazy(() => import('./pages/Protocol'))
const Admin        = lazy(() => import('./pages/Admin'))

function SpoofedAddresses() {
  const names = spoofedAddresses()
  if (!names.length) return null
  return (
    <div style={{
      background: '#b45309', color: '#fff', fontSize: 12, fontWeight: 600,
      padding: '7px 14px', textAlign: 'center', lineHeight: 1.4,
    }}>
      contract addresses are overridden locally ({names.join(', ')}). if you did not set this
      yourself, clear your browser storage for this site before trading.
    </div>
  )
}

function NetworkStalled() {
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    let alive = true
    const ask = async () => {
      const st = await netState().catch(() => null)
      if (alive && st) setStalled(st.stalled)
    }
    ask()
    const timer = setInterval(ask, 20_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  if (!stalled) return null
  return (
    <div style={{
      background: '#9a3412', color: '#fff', fontSize: 12, fontWeight: 600,
      padding: '7px 14px', textAlign: 'center', lineHeight: 1.4,
    }}>
      the network is not producing epochs right now. anything you send will sit in the queue
      until it moves. do not send the same thing twice.
    </div>
  )
}

const Waiting = () => <div style={{ minHeight: '60vh' }} />

function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname } = useLocation()
  useEffect(() => { onClose() }, [pathname])
  if (!open) return null
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(13,22,38,.4)', zIndex: 70 }} />
      <div style={{ position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 71, boxShadow: 'var(--sh-lg)' }}>
        <Sidebar onNavigate={onClose} />
      </div>
    </>
  )
}

function Shell() {
  const isMobile = useIsMobile()
  const [drawer, setDrawer] = useState(false)
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 0))
  useEffect(() => {
    const onResize = () => setVh(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div
      className="text-ink"
      style={{ display: 'flex', flexDirection: 'column', height: vh ? `${vh}px` : '100dvh', overflow: 'hidden', background: 'transparent' }}
    >
      <div style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <TopNav compact={isMobile} onMenu={() => setDrawer(true)} />
        <SpoofedAddresses />
        <NetworkStalled />
        <main className="no-bar" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          <Suspense fallback={<Waiting />}>
          <Routes>
            <Route path="/"                        element={<Swap />} />
            <Route path="/pool"                    element={<Pool />} />
            <Route path="/pool/:poolAddress"       element={<AddLiquidity />} />
            <Route path="/pool/:poolAddress/add"   element={<AddLiquidity />} />
            <Route path="/pool/new"                element={<AddLiquidity />} />
            <Route path="/positions"               element={<MyPositions />} />
            <Route path="/leaderboard"             element={<Leaderboard />} />
            <Route path="/protocol"                element={<Protocol />} />
            <Route path="/admin"                   element={<Admin />} />
            <Route path="/launchpad"               element={<Navigate to="/" replace />} />
            <Route path="/vault"                   element={<Navigate to="/" replace />} />
            <Route path="/private"                 element={<Navigate to="/" replace />} />
            <Route path="/inbox"                   element={<Navigate to="/" replace />} />
            <Route path="/faucet"                  element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </main>
        <PriceTicker />
        </div>
        <WalletSidebar />
      </div>

      <Drawer open={drawer && isMobile} onClose={() => setDrawer(false)} />
    </div>
  )
}

export default function App() {
  useEffect(() => {
    refreshTokensFromPools()
    ensureCompatProbed()
    const id = setInterval(() => { refreshTokensFromPools() }, 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <WalletProvider>
      <BrowserRouter>
        <Shell />
        <ConnectModal />
        <Toast />
        <ReferralCapture />
      </BrowserRouter>
    </WalletProvider>
  )
}
