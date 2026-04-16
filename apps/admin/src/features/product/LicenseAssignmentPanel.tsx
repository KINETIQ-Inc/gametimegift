import type { AssignProductLicenseResult, ProductListItem } from '@gtg/api'
import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import { LICENSE_OPTIONS, type LicenseAssignFormState, type LicenseBody } from './types'

interface LicenseAssignmentPanelProps {
  products: ProductListItem[]
  form: LicenseAssignFormState
  result: AssignProductLicenseResult | null
  submitting: boolean
  onFormChange: (next: LicenseAssignFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function LicenseAssignmentPanel(props: LicenseAssignmentPanelProps) {
  const { products, form, result, submitting, onFormChange, onSubmit } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>License Assignment</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Product
          <select
            required
            value={form.productId}
            onChange={(e) => {
              const selected = products.find((product) => product.id === e.target.value)
              onFormChange({
                ...form,
                productId: e.target.value,
                licenseBody: selected?.license_body ?? form.licenseBody,
              })
            }}
          >
            <option value="" disabled>
              Select product
            </option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.sku} - {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          License Body
          <select
            value={form.licenseBody}
            onChange={(e) =>
              onFormChange({ ...form, licenseBody: e.target.value as LicenseBody })
            }
          >
            {LICENSE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Royalty Override (blank clears override)
          <input
            type="number"
            step="0.0001"
            min="0"
            max="1"
            value={form.royaltyRate}
            onChange={(e) => onFormChange({ ...form, royaltyRate: e.target.value })}
            placeholder="0.1450"
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting || products.length === 0}>
          {submitting ? 'Assigning...' : 'Assign License'}
        </Button>
      </form>

      {result ? (
        <div className="upload-summary">
          <Heading as="h3" display={false}>Last License Assignment</Heading>
          <p>
            Product <strong>{result.sku}</strong> now uses <strong>{result.license_body}</strong>.
          </p>
          <p>
            Override rate: <strong>{result.royalty_rate ?? 'none'}</strong> | Effective rate:{' '}
            <strong>{result.effective_rate ?? 0}</strong>
          </p>
          <p>
            Active holder: <strong>{result.license_holder?.legal_name ?? 'N/A (NONE)'}</strong>
          </p>
        </div>
      ) : null}
    </section>
  )
}
