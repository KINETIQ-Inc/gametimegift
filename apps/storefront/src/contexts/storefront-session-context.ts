import { createContext } from 'react'
import type { SignUpCustomerInput, SignUpCustomerResult, AppAuthSession } from '@gtg/api'

type StorefrontUserRole =
  | 'customer'
  | 'consultant'
  | 'admin'
  | 'super_admin'
  | 'licensor_auditor'

export interface StorefrontSessionContextValue {
  sessionReady: boolean
  session: AppAuthSession
  role: StorefrontUserRole | null
  isAnonymous: boolean
  isAuthenticated: boolean
  isCustomer: boolean
  currentUserEmail: string | null
  signInCustomer: (input: { email: string; password: string }) => Promise<void>
  signUpCustomer: (input: SignUpCustomerInput) => Promise<SignUpCustomerResult>
  requestCustomerPasswordReset: (input: { email: string; redirectTo?: string }) => Promise<void>
  signOutCustomer: () => Promise<void>
  refreshManagedSession: () => Promise<AppAuthSession>
}

export const StorefrontSessionContext = createContext<StorefrontSessionContextValue | null>(null)
