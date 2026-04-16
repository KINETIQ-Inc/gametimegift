import { BasicProductCard } from '@gtg/ui'
import { AppStatePanel, parseAppPageState } from './_lib/route-ui'

const spotlightLinks = [
  { href: '/shop', label: 'Browse the Shop', description: 'View the full product grid route.' },
  { href: '/product/alabama-collector-football', label: 'Open a Product Page', description: 'Jump into a dynamic product detail route.' },
  { href: '/checkout', label: 'Preview Checkout', description: 'See the dedicated checkout route scaffold.' },
  { href: '/consultant', label: 'Consultant Portal', description: 'Open the consultant landing route.' },
] as const

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string }>
}) {
  const routeState = parseAppPageState((await searchParams)?.state)
  const stateMessageByKind = {
    loading: 'Preparing the App Router home experience…',
    empty: 'No featured route links are available yet.',
    error: 'The home route could not finish loading its navigation links.',
    success: 'The App Router home route is active and ready for navigation.',
  } as const

  return (
    <main>
      <section
        style={{
          padding: 32,
          borderRadius: 24,
          background: 'linear-gradient(160deg, #ffffff, #eef3fb)',
          boxShadow: '0 18px 48px rgba(3, 27, 82, 0.08)',
        }}
      >
        <p style={{ margin: 0, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#92600a', fontWeight: 800 }}>
          Home Route
        </p>
        <h2 style={{ margin: '10px 0 12px', fontSize: 40, lineHeight: 1.02 }}>
          The App Router shell is ready.
        </h2>
        <p style={{ margin: 0, maxWidth: 680, fontSize: 18, lineHeight: 1.6 }}>
          This page is the new `/app/page.tsx` entry point. It gives us a clean home route
          and clear navigation into shop, product, checkout, and consultant pages.
        </p>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          marginTop: 24,
        }}
      >
        <AppStatePanel
          kind={routeState ?? 'success'}
          title={`${(routeState ?? 'success').slice(0, 1).toUpperCase()}${(routeState ?? 'success').slice(1)} state`}
          message={stateMessageByKind[routeState ?? 'success']}
        />
        {spotlightLinks.map((item) => (
          <BasicProductCard
            key={item.href}
            href={item.href}
            title={item.label}
            description={item.description}
            ctaLabel="Open Route"
          />
        ))}
      </section>
    </main>
  )
}
