/**
 * App — router root for the Game Time Gift admin portal.
 *
 * Route map:
 *   /             → LoginPage       (public — redirects to /dashboard if authed)
 *   /dashboard    → ProductsPage    (product catalog management)
 *   /inventory    → InventoryPage   (serialized unit upload + batch validation)
 *   /royalties    → RoyaltiesPage   (royalty summaries and reports)
 *   /commissions  → CommissionsPage (commission lookup by consultant)
 *   /fraud        → FraudPage       (unit lock/unlock + fraud reports)
 *   /consultants  → ConsultantsPage (consultant management)
 *   /payouts      → PayoutsPage     (approve commission payouts)
 *   * (catch-all) → redirect to /
 *
 * Auth is provided by <AuthProvider>. All protected routes are wrapped
 * in <AdminShell> which enforces session and distributes shared state
 * via Outlet context (useAdminState()).
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth'
import { AdminShell } from './AdminShell'
import { LoginPage } from './pages/LoginPage'
import { ProductsPage } from './pages/ProductsPage'
import { InventoryPage } from './pages/InventoryPage'
import { RoyaltiesPage } from './pages/RoyaltiesPage'
import { CommissionsPage } from './pages/CommissionsPage'
import { FraudPage } from './pages/FraudPage'
import { ConsultantsPage } from './pages/ConsultantsPage'
import { PayoutsPage } from './pages/PayoutsPage'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LoginPage />} />

        {/* Protected — all wrapped by AdminShell which enforces auth */}
        <Route element={<AdminShell />}>
          <Route path="/dashboard" element={<ProductsPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/royalties" element={<RoyaltiesPage />} />
          <Route path="/commissions" element={<CommissionsPage />} />
          <Route path="/fraud" element={<FraudPage />} />
          <Route path="/consultants" element={<ConsultantsPage />} />
          <Route path="/payouts" element={<PayoutsPage />} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
