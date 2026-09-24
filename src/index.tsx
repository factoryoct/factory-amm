import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installMobileBridge } from './utils/mobileBridge'
import { bootTheme } from './utils/theme'

installMobileBridge()

bootTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
