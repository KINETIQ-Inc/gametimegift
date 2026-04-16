import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import type { EditFormState, LicenseBody } from './types'
import { LICENSE_OPTIONS } from './types'

interface EditProductPanelProps {
  form: EditFormState
  submitting: boolean
  onFormChange: (next: EditFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

export function EditProductPanel(props: EditProductPanelProps) {
  const { form, submitting, onFormChange, onSubmit, onCancel } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Edit Product</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Product ID
          <input value={form.productId} disabled />
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
          Royalty Rate (blank clears override)
          <input
            type="number"
            step="0.0001"
            min="0"
            max="1"
            value={form.royaltyRate}
            onChange={(e) => onFormChange({ ...form, royaltyRate: e.target.value })}
          />
        </label>
        <label>
          Cost (cents)
          <input
            type="number"
            min="1"
            value={form.costCents}
            onChange={(e) => onFormChange({ ...form, costCents: e.target.value })}
          />
        </label>
        <label>
          Retail Price (cents)
          <input
            type="number"
            min="1"
            value={form.retailPriceCents}
            onChange={(e) => onFormChange({ ...form, retailPriceCents: e.target.value })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => onFormChange({ ...form, isActive: e.target.checked })}
          />
          Active
        </label>
        <div className="inline-actions">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save Changes'}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  )
}
