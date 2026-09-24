import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify(Date.now().toString()),
  },
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      '/rpc': {
        target: 'https://devnet.octrascan.io',
        changeOrigin: true,
        secure: true,
      },
      '/price': {
        target: 'https://api.coingecko.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/api/v3/simple/price?ids=octra&vs_currencies=usd&include_24hr_change=true',
      },
      '/webcli': {
        target: 'http://127.0.0.1:8420',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/webcli/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'http://127.0.0.1:8420')
            proxyReq.removeHeader('sec-fetch-site')
            proxyReq.removeHeader('sec-fetch-mode')
            proxyReq.removeHeader('sec-fetch-dest')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
})
