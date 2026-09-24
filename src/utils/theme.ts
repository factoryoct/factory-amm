
export type Theme = 'light' | 'dark'

const KEY = 'oct_theme'

export function readTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export function applyTheme(t: Theme) {
  const r = document.documentElement
  if (t === 'dark') r.setAttribute('data-theme', 'dark')
  else r.removeAttribute('data-theme')
  try { localStorage.setItem(KEY, t) } catch {  }
}

export function bootTheme() {
  applyTheme(readTheme())
}
