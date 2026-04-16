import { lazy, Suspense } from 'react'
import { Navigate, Link, useParams } from 'react-router-dom'
import { Heading } from '@gtg/ui'
import { SiteNav } from '../components/nav/SiteNav'

const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)

type InfoSection = {
  title: string
  body: string
  bullets?: string[]
}

type InfoPageContent = {
  eyebrow: string
  title: string
  intro: string
  ctaLabel?: string
  ctaHref?: string
  sections: InfoSection[]
}

const INFO_PAGES: Record<string, InfoPageContent> = {
  'fathers-day-2026': {
    eyebrow: 'Seasonal Collection',
    title: 'Father’s Day 2026 — The Gift He’ll Actually Keep',
    intro: 'This is not another tie. Game Time Gift transforms the teams he loves into premium keepsakes designed to be displayed, used, and remembered. Give them their flowers.',
    ctaLabel: 'Shop the Father’s Day Collection',
    ctaHref: '/shop',
    sections: [
      {
        title: 'Give him the gift that lasts',
        body: 'Premium sports gifting built for the shelf, the office, and the moments that matter most.',
      },
      {
        title: 'Popular bundles',
        body: 'Vase Only · Vase + Flowers · Vase + Cigar Humidor Insert',
      },
      {
        title: 'Key dates',
        body: 'Pre-Order Opens: April 15, 2026 · Shipping Begins: May 15, 2026',
      },
      {
        title: 'Shop the full edit',
        body: 'Browse the latest licensed pieces, bundles, and gift-ready options in the main collection.',
      },
    ],
  },
  newsletter: {
    eyebrow: 'Newsletter',
    title: 'Stay in the Game',
    intro: 'Be the first to know. Join the Game Time Gift community for early access to new team releases, limited-edition drops, and exclusive offers tied to the biggest moments in sports.',
    ctaLabel: 'Sign Up Now',
    ctaHref: '/newsletter',
    sections: [
      {
        title: 'What you will get',
        body: 'From Father’s Day to Homecoming to Championship season, we release products when fans care most.',
        bullets: [
          'Early access to new school drops',
          'Limited edition product alerts',
          'Seasonal gift guides',
          'Special offers and bundles',
        ],
      },
      {
        title: 'Be first to know',
        body: 'Stay ahead of new releases and limited runs before they hit the public storefront.',
      },
    ],
  },
  returns: {
    eyebrow: 'Returns',
    title: 'Returns & Exchanges',
    intro: 'We stand behind the quality of every Game Time Gift product.',
    sections: [
      {
        title: 'Return window',
        body: '30 days from delivery',
      },
      {
        title: 'Eligible returns',
        body: 'Unused items · Original packaging intact · Proof of purchase required',
      },
      {
        title: 'Non-returnable',
        body: 'Customized or personalized items · Gift cards',
      },
      {
        title: 'Process',
        body: 'Contact support · Receive return authorization · Ship item back · Refund processed within 5–7 business days',
      },
    ],
  },
  'track-order': {
    eyebrow: 'Order Support',
    title: 'Track Your Order',
    intro: 'Enter your order number and email to get real-time updates on your shipment.',
    ctaLabel: 'Track Order',
    ctaHref: '/track-order',
    sections: [
      {
        title: 'What you will see',
        body: 'Order status · Shipping carrier · Estimated delivery date',
      },
      {
        title: 'Ready for live tracking',
        body: 'We will connect real-time carrier tracking here as soon as your shipping workflow is finalized.',
      },
    ],
  },
  shipping: {
    eyebrow: 'Shipping',
    title: 'Shipping Information',
    intro: 'We ship nationwide across the United States.',
    sections: [
      {
        title: 'Processing time',
        body: '2–4 business days',
      },
      {
        title: 'Shipping time',
        body: 'Standard: 3–5 business days · Expedited: 2–3 business days',
      },
      {
        title: 'Special events (Graduation / Father’s Day)',
        body: 'High-volume periods may affect processing — we recommend ordering early.',
      },
    ],
  },
  contact: {
    eyebrow: 'Support',
    title: 'Contact Us',
    intro: 'We’re here to help.',
    sections: [
      {
        title: 'Email',
        body: 'support@gametimegift.com',
      },
      {
        title: 'Phone',
        body: '(Insert Number)',
      },
      {
        title: 'Hours',
        body: 'Monday–Friday · 9:00 AM – 5:00 PM EST',
      },
      {
        title: 'For business inquiries',
        body: 'partnerships@gametimegift.com',
      },
    ],
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'Frequently Asked Questions',
    intro: 'Straight answers to the most common questions about Game Time Gift products.',
    sections: [
      {
        title: 'Are your products officially licensed?',
        body: 'Yes. Game Time Gift products are produced under official collegiate licensing agreements.',
      },
      {
        title: 'Are the vases waterproof?',
        body: 'Yes. All vases are fully functional and designed to hold water.',
      },
      {
        title: 'What are they made of?',
        body: 'High-quality resin with hand-finished detailing.',
      },
      {
        title: 'Do you offer cigar humidors?',
        body: 'Yes. Select Game Time Gift vessels include a cigar humidor insert option, allowing the product to function as both a display piece and a humidor. This is one of our most popular upgrades for Father’s Day and gifting occasions.',
      },
      {
        title: 'Do you offer bulk orders?',
        body: 'Yes. Visit our Corporate Gifts page for bulk pricing and custom options.',
      },
      {
        title: 'Can I add flowers?',
        body: 'Yes. Select bundles include floral arrangements, making the product ready for gifting upon arrival.',
      },
    ],
  },
  'gift-cards': {
    eyebrow: 'Gift Cards',
    title: 'Give Them the Choice',
    intro: 'Not sure which team or product to choose? Let them decide with a Game Time Gift digital gift card.',
    sections: [
      {
        title: 'Available amounts',
        body: '$50 / $100 / $150 / $200',
      },
      {
        title: 'Delivery',
        body: 'Delivered instantly via email.',
      },
    ],
  },
  'corporate-gifts': {
    eyebrow: 'Business Gifting',
    title: 'Corporate & Bulk Gifting',
    intro: 'Make a lasting impression. Game Time Gift offers premium sports-themed products ideal for corporate gifting, client appreciation, employee recognition, and events and sponsorships.',
    ctaLabel: 'Request a Quote',
    ctaHref: '/corporate-gifts',
    sections: [
      {
        title: 'Ideal for',
        body: 'Corporate gifting · Client appreciation · Employee recognition · Events and sponsorships',
      },
      {
        title: 'Capabilities',
        body: 'Bulk pricing · Custom packaging · Team-specific selections',
      },
    ],
  },
  affiliate: {
    eyebrow: 'Affiliate Program',
    title: 'Affiliate Program',
    intro: 'Turn your audience into income. Join the Game Time Gift affiliate program and earn commissions by sharing products your audience already loves.',
    ctaLabel: 'Apply Now',
    ctaHref: '/affiliate',
    sections: [
      {
        title: 'Benefits',
        body: 'Competitive commission rates · Unique tracking links · Marketing support',
      },
    ],
  },
  about: {
    eyebrow: 'About GTG',
    title: 'About Game Time Gift',
    intro: 'Game Time Gift was created to redefine sports gifting. We saw a gap — fans had jerseys and hats, but nothing meaningful to give during life moments like graduation, Father’s Day, or major milestones.',
    sections: [
      {
        title: 'So we built something different',
        body: 'Our products combine: Licensed team identity · Functional design · Emotional connection',
      },
      {
        title: 'Our goal',
        body: 'From military graduations to college campuses to living rooms — our goal is simple: Create gifts that last longer than the moment.',
      },
    ],
  },
  careers: {
    eyebrow: 'Careers',
    title: 'Careers',
    intro: 'We’re building something new — and we’re just getting started.',
    ctaLabel: 'Apply Now',
    ctaHref: '/careers',
    sections: [
      {
        title: 'We are hiring across',
        body: 'Marketing · Sales · Operations · Technology',
      },
      {
        title: 'Join the team',
        body: 'If you thrive in fast-moving environments and want to help build a national brand, we want to hear from you.',
      },
    ],
  },
  partnerships: {
    eyebrow: 'Partnerships',
    title: 'Partnerships',
    intro: 'We partner with organizations that align with our mission.',
    ctaLabel: 'Start a Conversation',
    ctaHref: '/partnerships',
    sections: [
      {
        title: 'Opportunities',
        body: 'Retail partnerships · Licensing collaborations · Event activations · Strategic brand alliances',
      },
      {
        title: 'Recent focus',
        body: 'Military academies · College bookstores · National retail distribution',
      },
    ],
  },
  privacy: {
    eyebrow: 'Privacy',
    title: 'Privacy Policy',
    intro: 'We respect your privacy and are committed to protecting your personal information.',
    sections: [
      {
        title: 'We collect',
        body: 'Order information · Contact details · Website usage data',
      },
      {
        title: 'We use it to',
        body: 'Process orders · Improve user experience · Communicate updates',
      },
      {
        title: 'We do not sell your personal information',
        body: 'Your personal data is never sold or shared for third-party marketing.',
      },
    ],
  },
  terms: {
    eyebrow: 'Terms',
    title: 'Terms & Conditions',
    intro: 'By using this website, you agree to the following:',
    sections: [
      {
        title: 'Terms',
        body: 'All products are subject to availability · Pricing may change without notice · Unauthorized use of content is prohibited · Game Time Gift reserves the right to update terms at any time.',
      },
    ],
  },
  accessibility: {
    eyebrow: 'Accessibility',
    title: 'Accessibility Statement',
    intro: 'Game Time Gift is committed to ensuring digital accessibility for all users.',
    sections: [
      {
        title: 'Our commitment',
        body: 'We are actively working to improve the usability of our website and ensure it meets accessibility standards.',
      },
      {
        title: 'Need help?',
        body: 'If you experience difficulty accessing any part of our site, please contact us.',
      },
    ],
  },
  cookies: {
    eyebrow: 'Cookies',
    title: 'Cookie Policy',
    intro: 'We use cookies to enhance your experience.',
    sections: [
      {
        title: 'Cookies help us',
        body: 'Understand user behavior · Improve site performance · Personalize content',
      },
      {
        title: 'Manage preferences',
        body: 'You can manage cookie preferences through your browser settings.',
      },
    ],
  },
}

export function InfoPage() {
  const { slug } = useParams<{ slug: string }>()
  const page = slug ? INFO_PAGES[slug] : undefined

  if (!page || !slug) {
    return <Navigate to="/" replace />
  }

  return (
    <main id="main-content" className="storefront info-page">
      <div className="container">
        <div className="storefront-shell">
          <section className="top-hero info-page-hero">
            <SiteNav mode="light" />
            <div className="info-page-hero__panel gtg-panel">
              <p className="info-page__eyebrow">{page.eyebrow}</p>
              <Heading as="h1" className="info-page__title">{page.title}</Heading>
              <p className="info-page__intro">{page.intro}</p>
              {page.ctaHref && page.ctaLabel ? (
                <Link to={page.ctaHref} className="gtg-btn gtg-btn--gold gtg-btn--lg">
                  {page.ctaLabel}
                </Link>
              ) : null}
            </div>
          </section>
        </div>

        <div className="home-band-inner">
          <section className="info-page-grid" aria-label={`${page.eyebrow} details`}>
            {page.sections.map((section) => (
              <article key={section.title} className="info-page-card gtg-card">
                <h2>{section.title}</h2>
                <p>{section.body}</p>
                {section.bullets ? (
                  <ul>
                    {section.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </section>
        </div>

        <Suspense fallback={null}>
          <StorefrontFooter />
        </Suspense>
      </div>
    </main>
  )
}
