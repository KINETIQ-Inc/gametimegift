import type { BulkUploadSerializedUnitsResult, ProductListItem } from '@gtg/api'
import type { FormEvent } from 'react'
import { Button, Heading } from '@gtg/ui'
import type { UploadFormState } from './types'

interface UploadUnitsPanelProps {
  products: ProductListItem[]
  form: UploadFormState
  result: BulkUploadSerializedUnitsResult | null
  submitting: boolean
  onFormChange: (next: UploadFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function UploadUnitsPanel(props: UploadUnitsPanelProps) {
  const { products, form, result, submitting, onFormChange, onSubmit } = props

  return (
    <section className="panel">
      <Heading as="h2" display={false}>Serialized Unit Upload (CSV)</Heading>
      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          Product
          <select
            required
            value={form.productId}
            onChange={(e) => onFormChange({ ...form, productId: e.target.value })}
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
          Batch Number
          <input
            required
            value={form.batchNumber}
            onChange={(e) => onFormChange({ ...form, batchNumber: e.target.value })}
            placeholder="BATCH-20260307-CLC-001"
          />
        </label>
        <label>
          Expected Unit Count
          <input
            required
            type="number"
            min="1"
            value={form.expectedUnitCount}
            onChange={(e) => onFormChange({ ...form, expectedUnitCount: e.target.value })}
          />
        </label>
        <label>
          Purchase Order Number
          <input
            value={form.purchaseOrderNumber}
            onChange={(e) => onFormChange({ ...form, purchaseOrderNumber: e.target.value })}
            placeholder="PO-2026-0311"
          />
        </label>
        <label>
          Notes
          <input
            value={form.notes}
            onChange={(e) => onFormChange({ ...form, notes: e.target.value })}
            placeholder="Optional receiving notes"
          />
        </label>
        <label>
          CSV File
          <input
            required
            type="file"
            accept=".csv,text/csv"
            onChange={(e) =>
              onFormChange({
                ...form,
                file: e.target.files?.[0] ?? null,
              })
            }
          />
        </label>
        <Button type="submit" variant="primary" disabled={submitting || products.length === 0}>
          {submitting ? 'Uploading...' : 'Upload CSV'}
        </Button>
      </form>

      {result ? (
        <div className="upload-summary">
          <Heading as="h3" display={false}>Last Upload Result</Heading>
          <p>
            Batch <strong>{result.batch_number}</strong> ({result.sku}) received{' '}
            <strong>{result.received_count}</strong> of <strong>{result.submitted_count}</strong>{' '}
            submitted units.
          </p>
          <p>
            Conflicts: <strong>{result.conflict_count}</strong>
          </p>
          {result.conflict_serials.length > 0 ? (
            <p className="conflicts">
              {result.conflict_serials.slice(0, 8).join(', ')}
              {result.conflict_serials.length > 8
                ? ` ... +${result.conflict_serials.length - 8} more`
                : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
