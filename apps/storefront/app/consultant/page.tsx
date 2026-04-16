import { Button } from '@gtg/ui'
import { ConsultantDashboardClient } from '../_components/ConsultantDashboardClient'
import { AppRouteSection, appCardStyle, parseAppPageState } from '../_lib/route-ui'

export default async function ConsultantPage({
  searchParams,
}: {
  searchParams?: Promise<{ consultantId?: string; state?: string }>
}) {
  const params = (await searchParams) ?? {}
  const routeState = parseAppPageState(params.state)

  return (
    <main>
      <section
        style={{
          ...appCardStyle({
            padding: 30,
            background: 'linear-gradient(145deg, #031b52, #0f3a80)',
            color: '#ffffff',
            boxShadow: '0 18px 42px rgba(3, 27, 82, 0.18)',
          }),
        }}
      >
        <AppRouteSection
          eyebrow="Consultant Route"
          title="Consultant Portal"
          description="This route gives the App Router a dedicated consultant destination and keeps it connected to the same shared page navigation."
        >
          <ConsultantDashboardClient consultantId={params.consultantId} forcedState={routeState} />
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <form action="/shop">
              <Button type="submit" variant="gold">Go to Shop</Button>
            </form>
            <form action="/checkout">
              <Button type="submit" variant="secondary">Open Checkout</Button>
            </form>
          </div>
        </AppRouteSection>
      </section>
    </main>
  )
}
