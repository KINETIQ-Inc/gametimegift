/**
 * ProductsPage — "/dashboard"
 *
 * Product catalog management:
 *   - Filter and search products
 *   - Create new product
 *   - Assign license to product
 *   - View and edit product table
 */

import { CatalogFiltersPanel } from '../features/product/CatalogFiltersPanel'
import { CreateProductPanel } from '../features/product/CreateProductPanel'
import { LicenseAssignmentPanel } from '../features/product/LicenseAssignmentPanel'
import { ProductsTablePanel } from '../features/product/ProductsTablePanel'
import { EditProductPanel } from '../features/product/EditProductPanel'
import { useAdminState } from '../useAdminState'

export function ProductsPage() {
  const {
    products,
    total,
    search,
    licenseFilter,
    createForm,
    editForm,
    licenseAssignForm,
    licenseAssignResult,
    loading,
    submitting,
    setSearch,
    setLicenseFilter,
    setCreateForm,
    setEditForm,
    setLicenseAssignForm,
    loadProducts,
    onCreateSubmit,
    onEditSubmit,
    onDeactivate,
    onAssignLicenseSubmit,
    createEditState,
  } = useAdminState()

  return (
    <>
      <section className="hero">
        <h1 className="admin-page-title">Product Catalog</h1>
        <p className="admin-page-sub">Create, update, search, and deactivate products.</p>
      </section>

      <CatalogFiltersPanel
        search={search}
        licenseFilter={licenseFilter}
        loading={loading}
        submitting={submitting}
        onSearchChange={setSearch}
        onLicenseFilterChange={setLicenseFilter}
        onRefresh={() => void loadProducts()}
      />

      <CreateProductPanel
        form={createForm}
        submitting={submitting}
        onSubmit={(e) => void onCreateSubmit(e)}
        onFormChange={setCreateForm}
      />

      <LicenseAssignmentPanel
        products={products}
        form={licenseAssignForm}
        result={licenseAssignResult}
        submitting={submitting}
        onFormChange={setLicenseAssignForm}
        onSubmit={(e) => void onAssignLicenseSubmit(e)}
      />

      <ProductsTablePanel
        products={products}
        loading={loading}
        submitting={submitting}
        total={total}
        onEdit={(product) => setEditForm(createEditState(product))}
        onDeactivate={(productId) => void onDeactivate(productId)}
      />

      {editForm ? (
        <EditProductPanel
          form={editForm}
          submitting={submitting}
          onFormChange={(next) => setEditForm(next)}
          onSubmit={(e) => void onEditSubmit(e)}
          onCancel={() => setEditForm(null)}
        />
      ) : null}
    </>
  )
}
