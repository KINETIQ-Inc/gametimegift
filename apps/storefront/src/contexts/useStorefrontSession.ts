import { useContext } from 'react'
import { StorefrontSessionContext } from './storefront-session-context'
import type { StorefrontSessionContextValue } from './storefront-session-context'

export type { StorefrontSessionContextValue }

export function useStorefrontSession(): StorefrontSessionContextValue {
  const ctx = useContext(StorefrontSessionContext)
  if (!ctx) {
    throw new Error('useStorefrontSession() must be used inside <StorefrontSessionProvider>.')
  }
  return ctx
}
