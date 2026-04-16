import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import type { CreateFormState, LicenseBody } from './types'
import { LICENSE_OPTIONS } from './types'

interface CreateProductPanelProps {
  form: CreateFormState
  submitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onFormChange: (next: CreateFormState) => void
}

export function CreateProductPanel(props: CreateProductPanelProps) {
  const { form, submitting, onSubmit, onFormChange } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Create Product</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          SKU
          <input
            required
            value={form.sku}
            onChange={(e) => onFormChange({ ...form, sku: e.target.value })}
            placeholder="APP-NIKE-JERSEY-M"
          />
        </label>
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => onFormChange({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Description
          <input
            value={form.description}
            onChange={(e) => onFormChange({ ...form, description: e.target.value })}
          />
        </label>
        <label>
          School
          <input
            value={form.school}
            onChange={(e) => onFormChange({ ...form, school: e.target.value })}
            placeholder="University of Florida"
          />
        </label>
        <label>
          License Body
          <select
            value={form.licenseBody}
            onChange={(e) => onFormChange({ ...form, licenseBody: e.target.value as LicenseBody })}
          >
            {LICENSE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Royalty Rate (0-1)
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
        <label>
          Cost (cents)
          <input
            required
            type="number"
            min="1"
            value={form.costCents}
            onChange={(e) => onFormChange({ ...form, costCents: e.target.value })}
          />
        </label>
        <label>
          Retail Price (cents)
          <input
            required
            type="number"
            min="1"
            value={form.retailPriceCents}
            onChange={(e) => onFormChange({ ...form, retailPriceCents: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Saving...' : 'Create Product'}
        </Button>
      </form>
    </section>
  )
}
