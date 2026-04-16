import { createContext, useContext, type ReactNode } from 'react'

export interface StorefrontSessionContextValue {
  sessionReady: boolean
}

const StorefrontSessionContext = createContext<StorefrontSessionContextValue | null>(null)

export function StorefrontSessionProvider({
  value,
  children,
}: {
  value: StorefrontSessionContextValue
  children: ReactNode
}) {
  return (
    <StorefrontSessionContext.Provider value={value}>
      {children}
    </StorefrontSessionContext.Provider>
  )
}

export function useStorefrontSession(): StorefrontSessionContextValue {
  const ctx = useContext(StorefrontSessionContext)
  if (!ctx) {
    throw new Error('useStorefrontSession() must be used inside <StorefrontSessionProvider>.')
  }
  return ctx
}
