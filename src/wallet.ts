import { ZeroXIOWallet } from '@0xio/sdk'

export const wallet = new ZeroXIOWallet({
  appName: 'Factory',
  appDescription: 'Octra AMM — concentrated liquidity DEX',
  requiredPermissions: ['read_balance', 'send_transactions'],
  debug: false,
})

let _initPromise: Promise<boolean> | null = null

export async function initWallet(): Promise<boolean> {
  if (_initPromise) return _initPromise
  _initPromise = wallet.initialize().catch(() => {
    _initPromise = null
    return false
  })
  return _initPromise
}
