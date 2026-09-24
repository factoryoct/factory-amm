import { useEffect, useState } from 'react'
import { loadLook, safeUrl } from '../utils/tokenMeta'

const LOGOS: Record<string, string> = {
  OCT:  '/oct.jpg',
  WOCT: '/oct.jpg',
  FACT: '/fact.png',
  COG:  '/cog.png',
  SPRK: '/sprk.png',
  LUM:  '/lum.png',
}

interface Props {
  symbol: string
  address?: string
  size?: number
  style?: React.CSSProperties
}

export default function TokenIcon({ symbol, address, size = 22, style }: Props) {
  const own = LOGOS[symbol]
  const [fromChain, setFromChain] = useState('')
  useEffect(() => {
    if (own || !address) { setFromChain(''); return }
    let alive = true
    void loadLook(address).then(l => { if (alive) setFromChain(safeUrl(l.image)) })
    return () => { alive = false }
  }, [own, address])
  const [bad, setBad] = useState(false)
  useEffect(() => { setBad(false) }, [fromChain])

  const src = own || (bad ? '' : fromChain)
  const base: React.CSSProperties = {
    width: size, height: size,
    flexShrink: 0,
    display: 'block',
    ...style,
  }

  if (src) {
    return <img src={src} alt={symbol} onError={() => setBad(true)} style={{ ...base, objectFit: 'cover' }} />
  }

  return (
    <div style={{
      ...base,
      background: 'var(--oct-color-surface)',
      border: '1px solid #e8e9ec',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--oct-type-mono)',
      fontSize: Math.round(size * 0.45), fontWeight: 700, color: 'var(--oct-color-text)',
    }}>
      {symbol[0]}
    </div>
  )
}
