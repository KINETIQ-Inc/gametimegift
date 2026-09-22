import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import { LICENSED_SCHOOLS, generateStyleKey } from '@gtg/api'
import type { CreateFormState, LicenseBody, ProductCategory, ApparelSize, GarmentType } from './types'
import { LICENSE_OPTIONS, PRODUCT_CATEGORY_OPTIONS, GARMENT_TYPE_OPTIONS, APPAREL_SIZE_OPTIONS } from './types'

interface CreateProductPanelProps {
  form: CreateFormState
  submitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onFormChange: (next: CreateFormState) => void
}

export function CreateProductPanel(props: CreateProductPanelProps) {
  const { form, submitting, onSubmit, onFormChange } = props

  const isApparel = form.category === 'APPAREL'
  // style_key is never admin-invented — it's computed from school + garment
  // type (docs/adr/0001-style-key-immutability.md). Preview only; the actual
  // value is computed server-side at creation.
  const previewStyleKey = isApparel && form.school && form.garmentType
    ? generateStyleKey(form.school, form.garmentType)
    : null
  const previewSku = previewStyleKey && form.size ? `${previewStyleKey}-${form.size}` : null

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
          {form.licenseBody === 'CLC' ? (
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
          Category
          <select
            value={form.category}
            onChange={(e) => {
              const category = e.target.value as ProductCategory
              // Clear apparel fields when switching back to COLLECTIBLE so a
              // stray size/color/garmentType can't be submitted for it.
              onFormChange(
                category === 'COLLECTIBLE'
                  ? { ...form, category, garmentType: '', size: '', color: '' }
                  : { ...form, category },
              )
            }}
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
              Garment Type
              <select
                value={form.garmentType}
                onChange={(e) => onFormChange({ ...form, garmentType: e.target.value as GarmentType })}
              >
                <option value="">— Select a garment type —</option>
                {GARMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Size
              <select
                value={form.size}
                onChange={(e) => onFormChange({ ...form, size: e.target.value as ApparelSize })}
              >
                <option value="">— Select a size —</option>
                {APPAREL_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Color (optional)
              <input
                value={form.color}
                onChange={(e) => onFormChange({ ...form, color: e.target.value })}
                placeholder="Navy"
              />
            </label>
            {previewSku ? (
              <p className="form-hint">
                style_key will be <code>{previewStyleKey}</code> — suggested SKU:{' '}
                <code>{previewSku}</code>
                {form.sku !== previewSku ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onFormChange({ ...form, sku: previewSku })}
                  >
                    Use this SKU
                  </Button>
                ) : null}
              </p>
            ) : (
              <p className="form-hint">
                Select a licensed school, garment type, and size to generate the style_key and SKU.
              </p>
            )}
          </>
        ) : null}
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
