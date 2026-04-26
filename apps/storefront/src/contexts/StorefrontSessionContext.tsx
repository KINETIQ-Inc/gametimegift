import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  ensureAnonymousSession,
  getAuthSession,
  refreshAuthSession,
  requestPasswordReset,
  signInWithPassword as signInWithPasswordApi,
  signOut as signOutApi,
  signUpCustomer as signUpCustomerApi,
  subscribeToAuthChanges,
  type AppAuthSession,
  type SignUpCustomerInput,
  type SignUpCustomerResult,
} from '@gtg/api'
import { StorefrontSessionContext } from './storefront-session-context'

export type { StorefrontSessionContextValue } from './storefront-session-context'

type StorefrontUserRole =
  | 'customer'
  | 'consultant'
  | 'admin'
  | 'super_admin'
  | 'licensor_auditor'

const VALID_ROLES: readonly StorefrontUserRole[] = [
  'customer',
  'consultant',
  'admin',
  'super_admin',
  'licensor_auditor',
] as const

function isKnownRole(value: unknown): value is StorefrontUserRole {
  return typeof value === 'string' && VALID_ROLES.includes(value as StorefrontUserRole)
}

function isAnonymousSession(session: AppAuthSession): boolean {
  const user = session?.user as { is_anonymous?: boolean } | undefined
  return user?.is_anonymous === true
}

function getRoleFromSession(session: AppAuthSession): StorefrontUserRole | null {
  const role = session?.user?.app_metadata?.['role']
  return isKnownRole(role) ? role : null
}

export function StorefrontSessionProvider({ children }: { children: ReactNode }) {
  const [sessionReady, setSessionReady] = useState(false)
  const [session, setSession] = useState<AppAuthSession>(null)

  async function refreshManagedSession(): Promise<AppAuthSession> {
    const refreshedSession = await refreshAuthSession()
    setSession(refreshedSession)
    setSessionReady(true)
    return refreshedSession
  }

  useEffect(() => {
    let active = true

    async function bootstrap(): Promise<void> {
      try {
        const existingSession = await getAuthSession()
        if (!active) return

        if (existingSession) {
          setSession(existingSession)
          setSessionReady(true)
          return
        }

        const anonymousSession = await ensureAnonymousSession()
        if (!active) return

        setSession(anonymousSession)
        setSessionReady(true)
      } catch {
        if (!active) return
        setSession(null)
        setSessionReady(true)
      }
    }

    void bootstrap()

    const unsubscribe = subscribeToAuthChanges((nextSession) => {
      if (!active) return
      setSession(nextSession)
      setSessionReady(true)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const role = getRoleFromSession(session)
  const isAnonymous = isAnonymousSession(session)
  const isAuthenticated = session !== null && !isAnonymous
  const isCustomer = isAuthenticated && role === 'customer'
  const currentUserEmail = typeof session?.user?.email === 'string'
    ? session.user.email
    : null

  async function signInCustomer(input: { email: string; password: string }): Promise<void> {
    await signInWithPasswordApi(input)
    await refreshManagedSession()
  }

  async function signUpCustomer(input: SignUpCustomerInput): Promise<SignUpCustomerResult> {
    const result = await signUpCustomerApi(input)
    if (result.session) {
      await refreshManagedSession()
    }
    return result
  }

  async function requestCustomerPasswordReset(input: {
    email: string
    redirectTo?: string
  }): Promise<void> {
    await requestPasswordReset(input)
  }

  async function signOutCustomer(): Promise<void> {
    await signOutApi()
    try {
      const anonymousSession = await ensureAnonymousSession()
      setSession(anonymousSession)
    } catch {
      setSession(null)
    } finally {
      setSessionReady(true)
    }
  }

  return (
    <StorefrontSessionContext.Provider
      value={{
        sessionReady,
        session,
        role,
        isAnonymous,
        isAuthenticated,
        isCustomer,
        currentUserEmail,
        signInCustomer,
        signUpCustomer,
        requestCustomerPasswordReset,
        signOutCustomer,
        refreshManagedSession,
      }}
    >
      {children}
    </StorefrontSessionContext.Provider>
  )
}
