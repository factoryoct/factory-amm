export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      borderRadius: {
        DEFAULT: '10px',
        sm: '8px', md: '14px', lg: '20px', xl: '26px', '2xl': '32px', full: '999px',
      },
      colors: {
        bg:      'var(--oct-color-surface-soft)',
        surface: 'var(--oct-color-bg)',
        panel:   'var(--oct-color-surface)',
        border:  'var(--oct-color-border)',
        accent:  'var(--oct-color-primary)',
        soft:    'var(--oct-color-primary-soft)',
        muted:   'var(--oct-color-muted)',
        ink:     'var(--oct-color-text)',
        header:  'var(--oct-color-header)',
        success: 'var(--oct-color-success)',
        danger:  'var(--oct-color-danger)',
        warning: 'var(--oct-color-warning)',
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', '"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Consolas', 'monospace'],
      },
      fontSize: {
        '10': ['10px', { lineHeight: '150%' }],
        '11': ['11px', { lineHeight: '150%' }],
        '12': ['12px', { lineHeight: '150%' }],
      },
    },
  },
  plugins: [],
}
