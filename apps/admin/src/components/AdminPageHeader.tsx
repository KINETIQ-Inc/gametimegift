import { SectionIntro } from '@gtg/ui'

export function AdminPageHeader() {
  return (
    <section className="hero">
      <SectionIntro
        eyebrow="Game Time Gift Admin"
        title="Product Management"
        titleAs="h1"
        description="Create, update, search, and deactivate products from one screen."
      />
    </section>
  )
}
