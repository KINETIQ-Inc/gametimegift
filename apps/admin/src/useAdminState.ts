import { useOutletContext } from 'react-router-dom'
import type { AdminDashboardState } from './AdminShell'

export function useAdminState(): AdminDashboardState {
  return useOutletContext<AdminDashboardState>()
}
