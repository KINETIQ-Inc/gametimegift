/**
 * ConsultantPage — rendered at "/consultant"
 *
 * Sections (in order):
 *   1. SiteNav          — persistent top nav (light mode)
 *   2. HeroSection      — headline + value proposition
 *   3. HowItWorks       — 3-step explainer (refer → customer buys → earn commission)
 *   4. EarningsSection  — commission structure overview
 *   5. ReferralDemo     — how referral links work (querystring ?ref=CODE)
 *   6. JoinSection      — CTA to request consultant access (form placeholder)
 *   7. FaqSection       — 4 key questions answered
 *   8. StorefrontFooter — shared footer
 *
 * This is a Phase 1 structural page. Form submission is not yet wired to
 * a backend. The consultant program is accessed via referral code attribution
 * (ConsultantAttributionBanner on the storefront).
 */

import { lazy, Suspense, useState } from 'react'
import { Badge, Button, Heading } from '@gtg/ui'
import { SiteNav } from '../components/nav/SiteNav'

const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)

function DeferredFallback({ minHeight = 160 }: { minHeight?: number }) {
  return <div style={{ minHeight }} aria-hidden="true" />
}

// ── Sub-sections ──────────────────────────────────────────────

function ConsultantHero() {
  return (
    <section className="consultant-hero" aria-label="Consultant program overview">
      <div className="consultant-hero__inner">
        <Badge variant="licensed">Consultant Program</Badge>
        <Heading as="h1" align="center" italic>
          Share the Gift.<br />Earn on Every Sale.
        </Heading>
        <p className="consultant-hero__subtitle">
          Game Time Gift consultants earn a commission on every order placed through their
          personal referral link. No inventory. No minimums. No setup fees.
        </p>
        <div className="consultant-hero__actions">
          <a href="#join" className="gtg-btn gtg-btn--gold gtg-btn--lg">
            Become a Consultant
          </a>
          <a href="#how-it-works" className="gtg-btn gtg-btn--secondary gtg-btn--lg">
            See How It Works
          </a>
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  const steps = [
    {
      step: '01',
      title: 'Get Your Code',
      body: 'Request access below. We issue you a personal consultant code (e.g. GTG-YOURNAME).',
    },
    {
      step: '02',
      title: 'Share Your Link',
      body: 'Append ?ref=YOUR-CODE to any Game Time Gift URL and share it with your network.',
    },
    {
      step: '03',
      title: 'Earn Commission',
      body: 'When a customer completes an order through your link, you earn a percentage of the sale — automatically tracked.',
    },
  ] as const

  return (
    <section id="how-it-works" className="consultant-steps" aria-label="How the consultant program works">
      <Heading as="h2" align="center">How It Works</Heading>
      <p className="consultant-steps__subtitle">
        Three steps from signup to your first commission.
      </p>

      <ol className="consultant-steps__list" role="list">
        {steps.map(({ step, title, body }) => (
          <li key={step} className="consultant-step">
            <span className="consultant-step__number" aria-hidden="true">{step}</span>
            <div className="consultant-step__content">
              <Heading as="h3" display={false}>{title}</Heading>
              <p>{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function EarningsSection() {
  return (
    <section className="consultant-earnings" aria-label="Earnings structure">
      <div className="consultant-earnings__inner">
        <Heading as="h2">Your Earnings</Heading>
        <p>
          Every completed order attributed to your referral link earns you a commission,
          paid out on a monthly basis.
        </p>

        <ul className="consultant-earnings__list" role="list">
          <li className="consultant-earnings__item">
            <span className="consultant-earnings__label">Commission rate</span>
            <span className="consultant-earnings__value">Disclosed at onboarding</span>
          </li>
          <li className="consultant-earnings__item">
            <span className="consultant-earnings__label">Attribution window</span>
            <span className="consultant-earnings__value">30 days from first click</span>
          </li>
          <li className="consultant-earnings__item">
            <span className="consultant-earnings__label">Minimum payout</span>
            <span className="consultant-earnings__value">No minimum</span>
          </li>
          <li className="consultant-earnings__item">
            <span className="consultant-earnings__label">Payout method</span>
            <span className="consultant-earnings__value">Direct deposit (ACH)</span>
          </li>
          <li className="consultant-earnings__item">
            <span className="consultant-earnings__label">Payout schedule</span>
            <span className="consultant-earnings__value">Monthly, net 30</span>
          </li>
        </ul>
      </div>
    </section>
  )
}

function ReferralDemo() {
  return (
    <section className="consultant-demo" aria-label="How referral links work">
      <Heading as="h2" display={false}>Your Referral Link</Heading>
      <p>
        Every product page and the homepage accepts a <code>?ref=</code> query parameter.
        When a customer lands on the site through your link, their session is attributed to
        you for 30 days.
      </p>

      <div className="consultant-demo__example" aria-label="Example referral URL">
        <p className="consultant-demo__label">Example link:</p>
        <code className="consultant-demo__url">
          gametimegift.com/?ref=GTG-YOURNAME
        </code>
        <p className="consultant-demo__note">
          Replace GTG-YOURNAME with your assigned consultant code.
          Share this link anywhere — social, email, text, or in person.
        </p>
      </div>
    </section>
  )
}

function JoinSection() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault()
    // TODO: wire to backend consultant application API
    setSubmitted(true)
  }

  return (
    <section id="join" className="consultant-join" aria-label="Apply to become a consultant">
      <div className="consultant-join__inner">
        <Heading as="h2" align="center">Become a Consultant</Heading>
        <p className="consultant-join__subtitle">
          Fill out the form below and we&apos;ll reach out with your personal code and onboarding details.
        </p>

        {submitted ? (
          <div className="consultant-join__success" role="status">
            <p>
              <strong>Application received.</strong> We&apos;ll be in touch within 1–2 business days.
            </p>
          </div>
        ) : (
          <form className="consultant-join__form" onSubmit={handleSubmit}>
            <label>
              Full name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
                autoComplete="name"
              />
            </label>
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </label>
            <Button type="submit" variant="gold" size="lg">
              Request Consultant Access
            </Button>
            <p className="consultant-join__disclaimer">
              By submitting, you agree to our consultant program terms.
              No payment required to join.
            </p>
          </form>
        )}
      </div>
    </section>
  )
}

function FaqSection() {
  const faqs = [
    {
      q: 'Do I need to buy or stock inventory?',
      a: 'No. You share a link. We handle all inventory, fulfillment, and customer service.',
    },
    {
      q: 'How is my referral tracked?',
      a: 'When a customer clicks your link, a code is stored in their session for 30 days. Any order placed in that window is attributed to you.',
    },
    {
      q: 'When and how do I get paid?',
      a: 'Commissions are calculated monthly and paid via direct deposit. No minimums to qualify for a payout.',
    },
    {
      q: 'Can I refer other consultants?',
      a: 'Multi-level referral structure details are disclosed during onboarding. Contact us for specifics.',
    },
  ] as const

  return (
    <section className="consultant-faq" aria-label="Frequently asked questions">
      <Heading as="h2" align="center" display={false}>Frequently Asked Questions</Heading>

      <dl className="consultant-faq__list">
        {faqs.map(({ q, a }) => (
          <div key={q} className="consultant-faq__item">
            <dt className="consultant-faq__question">{q}</dt>
            <dd className="consultant-faq__answer">{a}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// ── ConsultantPage ────────────────────────────────────────────

export function ConsultantPage() {
  return (
    <main id="main-content" className="consultant-page">
      <div className="container">
      {/* ── 1. Navigation ── */}
      <SiteNav mode="light" />

      {/* ── 2. Hero ── */}
      <ConsultantHero />

      {/* ── 3. How it works ── */}
      <HowItWorks />

      {/* ── 4. Earnings ── */}
      <EarningsSection />

      {/* ── 5. Referral demo ── */}
      <ReferralDemo />

      {/* ── 6. Join form ── */}
      <JoinSection />

      {/* ── 7. FAQ ── */}
      <FaqSection />

      {/* ── 8. Footer ── */}
      <Suspense fallback={<DeferredFallback minHeight={180} />}>
        <StorefrontFooter />
      </Suspense>
      </div>
    </main>
  )
}
