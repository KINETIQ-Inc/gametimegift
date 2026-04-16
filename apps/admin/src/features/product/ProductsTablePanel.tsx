import type { ProductListItem } from '@gtg/api'
import { Button, Heading } from '@gtg/ui'
import { toCurrency } from './types'

interface ProductsTablePanelProps {
  products: ProductListItem[]
  loading: boolean
  submitting: boolean
  total: number
  onEdit: (product: ProductListItem) => void
  onDeactivate: (productId: string) => void
}

export function ProductsTablePanel(props: ProductsTablePanelProps) {
  const { products, loading, submitting, total, onEdit, onDeactivate } = props

  return (
    <section className="panel">
      <div className="table-head">
        <Heading as="h2" display={false}>Products</Heading>
        <span>{loading ? 'Loading...' : `${products.length} shown / ${total} total`}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>School</th>
              <th>License</th>
              <th>Price</th>
              <th>Available</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.sku}</td>
                <td>{product.name}</td>
                <td>{product.school ?? '—'}</td>
                <td>{product.license_body}</td>
                <td>{toCurrency(product.retail_price_cents)}</td>
                <td>{product.available_count}</td>
                <td className="actions">
                  <Button size="sm" variant="secondary" onClick={() => onEdit(product)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onDeactivate(product.id)}
                    disabled={submitting}
                  >
                    Deactivate
                  </Button>
                </td>
              </tr>
            ))}
            {!loading && products.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No products found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
