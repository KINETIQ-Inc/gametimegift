import '@testing-library/jest-dom/vitest'

// supabase/functions/**/*.ts are Deno edge functions, but some are also
// unit-tested directly from Node via vitest (see
// supabase/functions/test/*.test.ts). Deno-only globals they touch (e.g.
// _shared/cors.ts's Deno.env.get() calls, all guarded with `?? 'default'`)
// need a minimal stand-in so those code paths don't crash under Node.
// This is a read-only shim — it never needs to return real values, only to
// exist, since every call site already has a fallback for a missing var.
if (typeof (globalThis as { Deno?: unknown }).Deno === 'undefined') {
  ;(globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno = {
    env: { get: () => undefined },
  }
}
