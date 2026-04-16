/**
 * Auth context for the admin portal.
 *
 * Wraps the router root. Provides session state and auth actions.
 * Uses auth wrappers from @gtg/api — never touches the Supabase client directly.
 *
 * Usage:
 *   const { session, loading, signIn, signOut } = useAuth()
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  getAuthSession,
  signInWithPassword,
  signOut as signOutApi,
  subscribeToAuthChanges,
  type AppAuthSession,
} from '@gtg/api'

type SupabaseSession = AppAuthSession

export interface AuthContextValue {
  session: SupabaseSession
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SupabaseSession>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void getAuthSession().then((session) => {
      setSession(session)
      setLoading(false)
    })

    return subscribeToAuthChanges((nextSession) => {
      setSession(nextSession)
    })
  }, [])

  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
    await signInWithPassword({ email, password })
  }, [])

  const signOut = useCallback(async (): Promise<void> => {
    await signOutApi()
  }, [])

  return (
    <AuthContext.Provider value={{ session, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}
