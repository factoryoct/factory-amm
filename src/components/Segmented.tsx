import { useEffect, useRef, useState, CSSProperties } from 'react'

export interface SegItem<T> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

export default function Segmented<T extends string | number>(p: {
  items: SegItem<T>[]
  value: T | null
  onChange: (v: T) => void
  mono?: boolean
  full?: boolean
  height?: number
  minItem?: number
  style?: CSSProperties
}) {
  const h = p.height ?? 28
  const n = p.items.length
  const active = p.items.findIndex(i => i.value === p.value)

  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setW(prev => (prev === el.clientWidth ? prev : el.clientWidth))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const item = w > 8 ? (w - 8) / n : 0

  return (
    <div
      ref={box}
      className="ui-seg"
      style={{
        position: 'relative',
        display: p.full ? 'flex' : 'inline-flex',
        width: p.full ? '100%' : undefined,
        ...p.style,
      }}
    >
      {item > 0 && active >= 0 && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 4,
            height: h,
            left: 4 + active * item,
            width: item,
            background: 'var(--oct-color-raised)',
            borderRadius: 'calc(var(--r-md) - 4px)',
            boxShadow: 'var(--sh-sm)',
            transition: 'left .26s cubic-bezier(.4, 0, .2, 1), width .26s cubic-bezier(.4, 0, .2, 1)',
            pointerEvents: 'none',
          }}
        />
      )}
      {p.items.map((it, i) => {
        const on = i === active
        return (
          <button
            key={String(it.value)}
            aria-pressed={on}
            disabled={it.disabled}
            title={it.title}
            onClick={() => { if (!it.disabled) p.onChange(it.value) }}
            style={{
              position: 'relative', zIndex: 1,
              height: h,
              width: item || undefined,
              flex: item ? '0 0 auto' : '1 1 auto',
              minWidth: 0,
              fontFamily: p.mono ? 'var(--oct-type-mono)' : undefined,
              fontWeight: on ? 600 : 500,
              color: on ? 'var(--oct-color-text)' : undefined,
              background: 'transparent',
              boxShadow: 'none',
              opacity: it.disabled ? 0.4 : 1,
              cursor: it.disabled ? 'not-allowed' : 'pointer',
            }}
          >{it.label}</button>
        )
      })}
    </div>
  )
}
