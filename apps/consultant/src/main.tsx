import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { configureApiClient } from '@gtg/api'
import { getEnv, initEnv } from '@gtg/config'
import '@gtg/ui/fonts.css'
import '@gtg/ui/tokens.css'
import '@gtg/ui/components.css'
import './index.css'
import App from './App.tsx'

initEnv(import.meta.env)

const env = getEnv()

configureApiClient({
  supabaseUrl: env.supabaseUrl,
  supabaseAnonKey: env.supabaseAnonKey,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
