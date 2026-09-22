import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import { LICENSED_SCHOOLS } from '@gtg/api'
import type { EditFormState, LicenseBody, ProductCategory, ProductLifecycleStatus } from './types'
import { LICENSE_OPTIONS, PRODUCT_CATEGORY_OPTIONS, PRODUCT_LIFECYCLE_STATUS_OPTIONS } from './types'

interface EditProductPanelProps {
  form: EditFormState
  submitting: boolean
  onFormChange: (next: EditFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

export function EditProductPanel(props: EditProductPanelProps) {
  const { form, submitting, onFormChange, onSubmit, onCancel } = props

  const isApparel = form.category === 'APPAREL'
  // Once a style_key exists, school/category are locked server-side too
  // (edit-product rejects changes to either) — see
  // docs/adr/0001-style-key-immutability.md. style_key is derived from
  // school + garment type, so changing school out from under it would
  // desync the two without ever touching style_key itself.
  const identityLocked = isApparel && Boolean(form.styleKey)

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
          School{identityLocked ? ' (fixed — apparel identity)' : ''}
          {identityLocked ? (
            <input value={form.school} disabled />
          ) : form.licenseBody === 'CLC' ? (
            <select
              value={form.school}
              onChange={(e) => onFormChange({ ...form, school: e.target.value })}
            >
              <option value="">— Select a licensed school —</option>
              {LICENSED_SCHOOLS.map((school) => (
                <option key={school} value={school}>
                  {school}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.school}
              onChange={(e) => onFormChange({ ...form, school: e.target.value })}
              placeholder="Optional — not applicable for most non-CLC products"
            />
          )}
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
          Category{identityLocked ? ' (fixed — apparel identity)' : ''}
          <select
            value={form.category}
            disabled={identityLocked}
            onChange={(e) => onFormChange({ ...form, category: e.target.value as ProductCategory })}
          >
            {PRODUCT_CATEGORY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {isApparel ? (
          <>
            <label>
              Size (fixed at creation)
              <input value={form.size ?? ''} disabled />
            </label>
            <label>
              style_key (fixed at creation)
              <input value={form.styleKey ?? ''} disabled />
            </label>
            <label>
              Color
              <input
                value={form.color}
                onChange={(e) => onFormChange({ ...form, color: e.target.value })}
                placeholder="Navy"
              />
            </label>
          </>
        ) : null}
        <label>
          Lifecycle Status
          <select
            value={form.lifecycleStatus}
            onChange={(e) => {
              const lifecycleStatus = e.target.value as ProductLifecycleStatus
              onFormChange({
                ...form,
                lifecycleStatus,
                isActive: lifecycleStatus === 'ACTIVE',
              })
            }}
          >
            {PRODUCT_LIFECYCLE_STATUS_OPTIONS.map((option) => (
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
            onChange={(e) => {
              const isActive = e.target.checked
              onFormChange({
                ...form,
                isActive,
                lifecycleStatus: isActive ? 'ACTIVE' : 'DISCONTINUED',
              })
            }}
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
