import type { UserRole } from '@gtg/types'
import { getSupabaseClient } from '@gtg/supabase'
import { ApiRequestError } from './error'

type SupabaseClient = ReturnType<typeof getSupabaseClient>

export type AppAuthSession = Awaited<
  ReturnType<SupabaseClient['auth']['getSession']>
>['data']['session']

let anonymousSignInPromise: Promise<AppAuthSession> | null = null
const SESSION_EXPIRY_GRACE_SECONDS = 60
const VALID_USER_ROLES: readonly UserRole[] = [
  'customer',
  'consultant',
  'admin',
  'super_admin',
  'licensor_auditor',
] as const

export interface SignUpCustomerInput {
  email: string
  password: string
  fullName?: string
  phone?: string
  emailRedirectTo?: string
}

export interface SignUpCustomerResult {
  userId: string | null
  session: AppAuthSession
  emailConfirmationRequired: boolean
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && VALID_USER_ROLES.includes(value as UserRole)
}

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
  const email = input.email.trim().toLowerCase()
  const password = input.password

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiRequestError(
      '[GTG] signInWithPassword(): email must be a valid email address.',
      'VALIDATION_ERROR',
    )
  }
  if (!password || password.length < 8) {
    throw new ApiRequestError(
      '[GTG] signInWithPassword(): password must be at least 8 characters.',
      'VALIDATION_ERROR',
    )
  }

  const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password })
  if (error) throw error
}

export async function signUpCustomer(input: SignUpCustomerInput): Promise<SignUpCustomerResult> {
  const email = input.email.trim().toLowerCase()
  const password = input.password
  const fullName = input.fullName?.trim()
  const phone = input.phone?.trim()
  const emailRedirectTo = input.emailRedirectTo?.trim()

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiRequestError(
      '[GTG] signUpCustomer(): email must be a valid email address.',
      'VALIDATION_ERROR',
    )
  }
  if (!password || password.length < 8) {
    throw new ApiRequestError(
      '[GTG] signUpCustomer(): password must be at least 8 characters.',
      'VALIDATION_ERROR',
    )
  }

  const { data, error } = await getSupabaseClient().auth.signUp({
    email,
    password,
    options: {
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
      data: {
        account_type: 'customer',
        ...(fullName ? { full_name: fullName } : {}),
        ...(phone ? { phone } : {}),
      },
    },
  })

  if (error) throw error

  return {
    userId: data.user?.id ?? null,
    session: data.session ?? null,
    emailConfirmationRequired: data.session === null,
  }
}

export async function requestPasswordReset(input: {
  email: string
  redirectTo?: string
}): Promise<void> {
  const email = input.email.trim().toLowerCase()
  const redirectTo = input.redirectTo?.trim()

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiRequestError(
      '[GTG] requestPasswordReset(): email must be a valid email address.',
      'VALIDATION_ERROR',
    )
  }

  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  )
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

export async function getCurrentUserRole(): Promise<UserRole | null> {
  const session = await getAuthSession()
  const role = session?.user?.app_metadata?.['role']
  return isUserRole(role) ? role : null
}
