const LOCAL_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
] as const

type AppEnv = 'development' | 'staging' | 'production'

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function parseOriginsEnv(value: string | undefined): string[] {
  if (!value) return []

  return value
    .split(',')
    .map((item) => normalizeOrigin(item.trim()))
    .filter((item): item is string => item !== null)
}

function getAppEnv(): AppEnv {
  const raw = (Deno.env.get('APP_ENV') ?? 'development').trim().toLowerCase()

  if (raw === 'staging' || raw === 'production') {
    return raw
  }

  return 'development'
}

function getEnvSpecificOrigins(appEnv: AppEnv): string[] {
  const envVarByAppEnv: Record<AppEnv, string> = {
    development: 'ALLOWED_WEB_ORIGINS_DEV',
    staging: 'ALLOWED_WEB_ORIGINS_STAGING',
    production: 'ALLOWED_WEB_ORIGINS_PROD',
  }

  return parseOriginsEnv(Deno.env.get(envVarByAppEnv[appEnv]))
}

function isPreviewOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.endsWith('.vercel.app')
    )
  } catch {
    return false
  }
}

export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(LOCAL_ALLOWED_ORIGINS)
  const appEnv = getAppEnv()
  const storefrontOrigin = normalizeOrigin(Deno.env.get('STOREFRONT_URL') ?? '')
  const sharedOrigins = parseOriginsEnv(Deno.env.get('ALLOWED_WEB_ORIGINS'))
  const envSpecificOrigins = getEnvSpecificOrigins(appEnv)

  if (storefrontOrigin) {
    origins.add(storefrontOrigin)
  }

  for (const origin of sharedOrigins) {
    origins.add(origin)
  }

  for (const origin of envSpecificOrigins) {
    origins.add(origin)
  }

  return origins
}

export function isAllowedOrigin(origin: string): boolean {
  if (getAllowedOrigins().has(origin)) {
    return true
  }

  // Allow ephemeral Vercel preview deployments outside production so preview
  // URLs can exercise the storefront checkout flow without manual allowlist
  // edits for every deployment hostname.
  return getAppEnv() !== 'production' && isPreviewOrigin(origin)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns CORS response headers for the given request.
 *
 * The reflected origin is only echoed back if it is in ALLOWED_ORIGINS.
 * An unrecognised origin receives an empty allow-origin header — the browser
 * will treat this as a CORS failure, which is the correct behaviour.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowedOrigin = isAllowedOrigin(origin) ? origin : ''
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  }
}

/**
 * Handle a CORS preflight request.
 *
 * Returns a 200 Response with CORS headers if the request method is OPTIONS,
 * otherwise returns null (the caller handles the actual request).
 *
 * Usage:
 *
 *   Deno.serve(async (req) => {
 *     const preflight = handleCors(req)
 *     if (preflight) return preflight
 *     // ... handle the real request
 *   })
 */
export function handleCors(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { status: 200, headers: corsHeaders(req) })
}
