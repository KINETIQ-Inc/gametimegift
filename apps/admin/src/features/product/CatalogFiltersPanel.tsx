import { Button, Heading } from '@gtg/ui'
import type { LicenseBody } from './types'
import { LICENSE_OPTIONS } from './types'

interface CatalogFiltersPanelProps {
  search: string
  licenseFilter: 'ALL' | LicenseBody
  loading: boolean
  submitting: boolean
  onSearchChange: (value: string) => void
  onLicenseFilterChange: (value: 'ALL' | LicenseBody) => void
  onRefresh: () => void
}

export function CatalogFiltersPanel(props: CatalogFiltersPanelProps) {
  const {
    search,
    licenseFilter,
    loading,
    submitting,
    onSearchChange,
    onLicenseFilterChange,
    onRefresh,
  } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Catalog Filters</Heading>
      <div className="filter-grid">
        <label>
          Search
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by product name"
          />
        </label>
        <label>
          License
          <select
            value={licenseFilter}
            onChange={(e) => onLicenseFilterChange(e.target.value as 'ALL' | LicenseBody)}
          >
            <option value="ALL">All</option>
            {LICENSE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={onRefresh} disabled={loading || submitting}>
          Refresh
        </Button>
      </div>
    </section>
  )
}
