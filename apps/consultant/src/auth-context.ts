import { createContext } from 'react'
import type { AppAuthSession } from '@gtg/api'

type SupabaseSession = AppAuthSession

export interface AuthContextValue {
  session: SupabaseSession
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
