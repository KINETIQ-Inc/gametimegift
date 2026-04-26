/**
 * InventoryPage — "/inventory"
 *
 * Serialized unit management:
 *   - Bulk upload units via CSV
 *   - Validate manufacturing batch
 */

import { UploadUnitsPanel } from '../features/product/UploadUnitsPanel'
import { BatchValidationPanel } from '../features/product/BatchValidationPanel'
import { useAdminState } from '../useAdminState'

export function InventoryPage() {
  const {
    products,
    uploadForm,
    uploadResult,
    batchValidationForm,
    batchValidationResult,
    submitting,
    setUploadForm,
    setBatchValidationForm,
    onUploadSubmit,
    onValidateBatchSubmit,
  } = useAdminState()

  return (
    <>
      <section className="hero">
        <h1 className="admin-page-title">Inventory</h1>
        <p className="admin-page-sub">Upload serialized units and validate manufacturing batches.</p>
      </section>

      <UploadUnitsPanel
        products={products}
        form={uploadForm}
        result={uploadResult}
        submitting={submitting}
        onFormChange={setUploadForm}
        onSubmit={(e) => void onUploadSubmit(e)}
      />

      <BatchValidationPanel
        form={batchValidationForm}
        result={batchValidationResult}
        submitting={submitting}
        onFormChange={setBatchValidationForm}
        onSubmit={(e) => void onValidateBatchSubmit(e)}
      />
    </>
  )
}
