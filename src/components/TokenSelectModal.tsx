import { useState, useEffect } from 'react'
import TokenIcon from './TokenIcon'
import { listTokens, probeToken, commitToken, duplicateSymbols, type TokenInfo } from '../config/tokens'

const M = 'var(--oct-type-mono)'
const F = 'var(--oct-type-ui)'
const ADDR_RE = /^oct[0-9A-Za-z]{20,}$/

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (t: TokenInfo) => void
  exclude?: string
}

export default function TokenSelectModal({ open, onClose, onSelect, exclude }: Props) {
  const [q, setQ]             = useState('')
  const [probing, setProbing] = useState(false)
  const [found, setFound]     = useState<TokenInfo | null>(null)
  const [sym, setSym]         = useState('')
  const [err, setErr]         = useState('')

  useEffect(() => { if (open) { setQ(''); setFound(null); setSym(''); setErr('') } }, [open])

  useEffect(() => {
    setFound(null); setErr(''); setSym('')
    const addr = q.trim()
    if (!ADDR_RE.test(addr)) { setProbing(false); return }
    if (listTokens().some(t => t.address === addr)) { setProbing(false); return }
    let alive = true
    setProbing(true)
    const timer = setTimeout(() => {
      probeToken(addr)
        .then(t => { if (alive) { setFound(t); setSym(t.symbol) } })
        .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
        .finally(() => { if (alive) setProbing(false) })
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [q])

  if (!open) return null

  const query = q.trim().toLowerCase()
  const dupes = duplicateSymbols()
  const known = listTokens().filter(t =>
    !query || t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query))

  function pick(t: TokenInfo) {
    onSelect(t)
    onClose()
  }
  const impostor = found
    ? listTokens().find(t => t.symbol.toUpperCase() === (sym.trim().toUpperCase() || found.symbol.toUpperCase())
                          && t.address !== found.address)
    : undefined

  function pickFound() {
    if (!found) return
    const final: TokenInfo = { ...found, symbol: (sym.trim().toUpperCase() || found.symbol).slice(0, 10) }
    commitToken(final)
    pick(final)
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,30,45,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
    >
      <div onClick={e => e.stopPropagation()} className="app-token-modal ui-card" style={{ width: 440, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--sh-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 8px' }}>
          <span style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 600 }}>select token</span>
          <button onClick={onClose} style={{ fontFamily: F, fontSize: 15, color: 'var(--oct-color-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="search name or paste contract address (oct...)"
            spellCheck={false}
            style={{ width: '100%', fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-bg)', border: '1px solid #e8e9ec', padding: '8px 10px', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        {probing && (
          <div style={{ padding: '10px 16px', fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)' }}>looking up on-chain…</div>
        )}
        {err && !probing && (
          <div style={{ padding: '10px 16px', fontFamily: F, fontSize: 13, color: '#b4534b' }}>{err}</div>
        )}
        {found && !probing && (
          <div style={{ margin: '10px 16px 0', padding: 12, background: 'var(--oct-color-bg)', border: 'none', boxShadow: 'var(--sh-sm)', borderRadius: 'var(--r-lg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <TokenIcon symbol={found.symbol} address={found.address} size={28} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 600 }}>
                  {found.symbol !== found.address.slice(3, 9) ? `${found.symbol} · ${found.name}` : 'found on-chain'} <span style={{ color: 'var(--oct-color-warning)', fontWeight: 400 }}>(unverified)</span>
                </div>
                <div style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-muted)', wordBreak: 'break-all' }}>{found.address}</div>
              </div>
            </div>
            {impostor && (
              <div style={{
                margin: '0 0 9px', padding: '8px 10px', borderRadius: 'var(--r-sm)',
                background: 'color-mix(in srgb, var(--oct-color-error) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--oct-color-error) 35%, transparent)',
                fontFamily: F, fontSize: 12, lineHeight: 1.45, color: 'var(--oct-color-text)',
              }}>
                <b>{impostor.symbol}</b> already exists at a different address
                (<span style={{ fontFamily: M }}>{impostor.address.slice(0, 10)}…{impostor.address.slice(-6)}</span>).
                any token can claim any name — check the address before you trade.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={sym}
                onChange={e => setSym(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') pickFound() }}
                placeholder="symbol"
                spellCheck={false}
                style={{ width: 110, fontFamily: M, fontSize: 13, color: 'var(--oct-color-text)', background: 'var(--oct-color-bg)', border: '1px solid #e8e9ec', padding: '7px 9px' }}
              />
              <button
                onClick={pickFound}
                style={{ flex: 1, fontFamily: F, fontSize: 13, color: 'var(--oct-color-action-ink)', background: 'var(--oct-color-action)', border: 'none', borderRadius: 'var(--r-sm)', padding: '7px 12px', cursor: 'pointer' }}>
                import & select
              </button>
            </div>
            {found.symbol === found.address.slice(3, 9) && (
              <div style={{ fontFamily: F, fontSize: 11, color: 'var(--oct-color-muted)', marginTop: 6 }}>
                this token has no on-chain symbol — name it here (added to the app on import)
              </div>
            )}
          </div>
        )}

        <div style={{ padding: 8, overflowY: 'auto' }}>
          {known.map(t => {
            const disabled = exclude === t.address
            return (
              <button
                key={t.address}
                onClick={() => { if (!disabled) pick(t) }}
                disabled={disabled}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                  padding: '8px 10px', background: 'transparent', border: '1px solid transparent',
                  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
                }}
                onMouseOver={e => { if (!disabled) (e.currentTarget.style.background = 'var(--oct-color-surface)', e.currentTarget.style.borderColor = 'var(--oct-color-border)') }}
                onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
              >
                <TokenIcon symbol={t.symbol} address={t.address} size={28} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: F, fontSize: 14, color: 'var(--oct-color-text)', fontWeight: 500 }}>
                    {t.symbol}
                    {t.verified === false && dupes.has(t.address)
                      ? <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, marginLeft: 6 }}>
                          same name as a known token, different address
                        </span>
                      : t.verified === false
                        ? <span style={{ fontSize: 11, color: 'var(--oct-color-warning)', marginLeft: 6 }}>unverified</span>
                        : null}
                  </div>
                  <div style={{ fontFamily: M, fontSize: 12, color: 'var(--oct-color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.native ? 'native OCT' : t.address}
                  </div>
                </div>
              </button>
            )
          })}
          {known.length === 0 && !found && !probing && (
            <div style={{ padding: '14px 10px', fontFamily: F, fontSize: 13, color: 'var(--oct-color-muted)' }}>
              no match — paste a full contract address to import a new token
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
