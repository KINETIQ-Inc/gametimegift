import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { configureApiClient, ensureAnonymousSession } from '@gtg/api'
import { getEnv, initEnv } from '@gtg/config'
import '@gtg/ui/fonts.css'
import '@gtg/ui/tokens.css'
import '@gtg/ui/components.css'
import './index.css'
import App from './App.tsx'
import { StorefrontSessionProvider } from './contexts/StorefrontSessionContext'

initEnv(import.meta.env)

const env = getEnv()

if (typeof window !== 'undefined') {
  window.history.scrollRestoration = 'manual'
  window.scrollTo(0, 0)
  document.documentElement.scrollLeft = 0
  document.body.scrollLeft = 0
}

configureApiClient({
  supabaseUrl: env.supabaseUrl,
  supabaseAnonKey: env.supabaseAnonKey,
})

function StorefrontBootScreen() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'linear-gradient(180deg, #f4f6fb 0%, #ffffff 100%)',
        color: '#1a2033',
      }}
      aria-busy="true"
      aria-live="polite"
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <p style={{ margin: '0 0 12px', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, color: '#92600a' }}>
          Secure Session
        </p>
        <h1 style={{ margin: '0 0 12px', fontSize: 32, lineHeight: 1.1 }}>
          Preparing your storefront session
        </h1>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>
          We&apos;re securing your session before any checkout actions become available.
        </p>
      </div>
    </div>
  )
}

function BootstrapApp() {
  const [sessionReady, setSessionReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function bootstrapSession(): Promise<void> {
      await ensureAnonymousSession()
      if (!cancelled) {
        setSessionReady(true)
      }
    }

    void bootstrapSession()

    return () => {
      cancelled = true
    }
  }, [])

  if (!sessionReady) {
    return <StorefrontBootScreen />
  }

  return (
    <StorefrontSessionProvider value={{ sessionReady }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StorefrontSessionProvider>
  )
}

function bootstrap(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BootstrapApp />
    </StrictMode>,
  )
}

bootstrap()
