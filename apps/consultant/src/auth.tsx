/**
 * AuthProvider — session state and auth actions for the consultant portal.
 *
 * Usage:
 *   const { session, loading, signIn, signOut } = useAuth()
 */

import {
  useCallback,
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
import { AuthContext } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppAuthSession>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void getAuthSession().then((s) => {
      setSession(s)
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
