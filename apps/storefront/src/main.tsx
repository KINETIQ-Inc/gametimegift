import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { configureApiClient } from '@gtg/api'
import { getEnv, initEnv } from '@gtg/config'
import '@gtg/ui/fonts.css'
import '@gtg/ui/tokens.css'
import '@gtg/ui/components.css'
import './index.css'
import { BootstrapApp, StorefrontErrorScreen } from './BootstrapScreens'

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
