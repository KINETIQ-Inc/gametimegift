import { useContext } from 'react'
import { StorefrontContext } from './storefront-context'
import type { StorefrontContextValue } from './StorefrontContext'

export type { StorefrontContextValue }

export function useStorefront(): StorefrontContextValue {
  const ctx = useContext(StorefrontContext)
  if (!ctx) {
    throw new Error('useStorefront() must be used inside <StorefrontProvider>.')
  }
  return ctx
}
