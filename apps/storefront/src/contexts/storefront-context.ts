import { createContext } from 'react'
import type { StorefrontContextValue } from './StorefrontContext'

export { type StorefrontContextValue }

export const StorefrontContext = createContext<StorefrontContextValue | null>(null)
