import { getSupabaseClient } from '@gtg/supabase'

type SupabaseClient = ReturnType<typeof getSupabaseClient>

export type AppAuthSession = Awaited<
  ReturnType<SupabaseClient['auth']['getSession']>
>['data']['session']

let anonymousSignInPromise: Promise<AppAuthSession> | null = null
const SESSION_EXPIRY_GRACE_SECONDS = 60

export async function getAuthSession(): Promise<AppAuthSession> {
  const { data } = await getSupabaseClient().auth.getSession()
  return data.session
}

function isSessionUsable(session: AppAuthSession): boolean {
  if (!session) return false
  if (!session.expires_at) return true

  const nowSeconds = Math.floor(Date.now() / 1000)
  return session.expires_at > nowSeconds + SESSION_EXPIRY_GRACE_SECONDS
}

export function subscribeToAuthChanges(
  onChange: (session: AppAuthSession) => void,
): () => void {
  const {
    data: { subscription },
  } = getSupabaseClient().auth.onAuthStateChange((_event, session) => {
    onChange(session)
  })

  return () => subscription.unsubscribe()
}

export async function signInWithPassword(input: {
  email: string
  password: string
}): Promise<void> {
  const { error } = await getSupabaseClient().auth.signInWithPassword(input)
  if (error) throw error
}

export async function ensureAnonymousSession(): Promise<AppAuthSession> {
  const existingSession = await getAuthSession()
  if (existingSession && isSessionUsable(existingSession)) {
    return existingSession
  }

  if (anonymousSignInPromise) {
    return anonymousSignInPromise
  }

  anonymousSignInPromise = (async () => {
    const client = getSupabaseClient()
    if (existingSession) {
      const { data, error } = await client.auth.refreshSession()
      if (!error) {
        const refreshedSession = data.session ?? await getAuthSession()
        if (refreshedSession && isSessionUsable(refreshedSession)) {
          return refreshedSession
        }
      }

      // The stored session is stale and not recoverable; clear it before
      // creating a fresh anonymous session.
      await client.auth.signOut()
    }

    const { data, error } = await client.auth.signInAnonymously()
    if (error) throw error

    const session = data.session ?? await getAuthSession()
    if (!session || !isSessionUsable(session)) {
      throw new Error('[GTG] ensureAnonymousSession(): anonymous session could not be established.')
    }

    return session
  })()

  try {
    return await anonymousSignInPromise
  } finally {
    anonymousSignInPromise = null
  }
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut()
  if (error) throw error
}
