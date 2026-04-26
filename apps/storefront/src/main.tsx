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
import { StorefrontSessionProvider } from './contexts/StorefrontSessionContext'

type BootstrapResult =
  | { ok: true; env: ReturnType<typeof getEnv> }
  | { ok: false; message: string }

if (typeof window !== 'undefined') {
  window.history.scrollRestoration = 'manual'
  window.scrollTo(0, 0)
  document.documentElement.scrollLeft = 0
  document.body.scrollLeft = 0
}

function initializeBootstrap(): BootstrapResult {
  try {
    initEnv(import.meta.env)
    const env = getEnv()

    configureApiClient({
      supabaseUrl: env.supabaseUrl,
      supabaseAnonKey: env.supabaseAnonKey,
    })

    return { ok: true, env }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const message = rawMessage.includes('VITE_SUPABASE_URL') || rawMessage.includes('VITE_SUPABASE_ANON_KEY')
      ? 'Missing Supabase environment variables. Check .env file.'
      : rawMessage
    console.error('[GTG] Storefront bootstrap failed', message)
    return { ok: false, message }
  }
}

function StorefrontErrorScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'linear-gradient(180deg, #fff8f5 0%, #ffffff 100%)',
        color: '#1a2033',
      }}
      role="alert"
      aria-live="assertive"
    >
      <div style={{ maxWidth: 720, textAlign: 'left' }}>
        <p style={{ margin: '0 0 12px', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, color: '#9c2f10' }}>
          Startup Error
        </p>
        <h1 style={{ margin: '0 0 12px', fontSize: 32, lineHeight: 1.1 }}>
          The storefront could not finish loading
        </h1>
        <p style={{ margin: '0 0 16px', fontSize: 16, lineHeight: 1.6 }}>
          The app hit a configuration or startup problem before React could render normally.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 16,
            borderRadius: 12,
            background: '#1a2033',
            color: '#f6f8ff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {message}
        </pre>
      </div>
    </div>
  )
}

function BootstrapApp() {
  return (
    <StorefrontSessionProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StorefrontSessionProvider>
  )
}

function bootstrap(): void {
  const bootstrapResult = initializeBootstrap()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {bootstrapResult.ok ? (
        <BootstrapApp />
      ) : (
        <StorefrontErrorScreen message={bootstrapResult.message} />
      )}
    </StrictMode>,
  )
}

bootstrap()
