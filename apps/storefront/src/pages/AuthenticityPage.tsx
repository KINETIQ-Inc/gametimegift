import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertBanner, Button, Heading } from '@gtg/ui'
import { verifyHologramSerial, toUserMessage, type VerifyHologramSerialResult } from '@gtg/api'
import { trackStorefrontEvent } from '../analytics'
import { SiteNav } from '../components/nav/SiteNav'

const StorefrontFooter = lazy(async () =>
  import('../components/footer/StorefrontFooter').then((m) => ({ default: m.StorefrontFooter })),
)

export function AuthenticityPage() {
  const [searchParams] = useSearchParams()
  const initialSerial = searchParams.get('serial') ?? ''
  const [input, setInput] = useState(initialSerial)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyHologramSerialResult | null>(null)

  useEffect(() => {
    if (!initialSerial) return
    setInput(initialSerial)
  }, [initialSerial])

  async function onVerify(): Promise<void> {
    const serial = input.trim()
    if (!serial) {
      setVerifyResult(null)
      setVerifyError('Please enter a serial number.')
      return
    }

    setVerifyLoading(true)
    setVerifyError(null)
    setVerifyResult(null)
    trackStorefrontEvent('verification_submitted', { serialLength: serial.length, routeKind: 'authenticity' })

    try {
      const result = await verifyHologramSerial(serial)
      setVerifyResult(result)
      trackStorefrontEvent('verification_succeeded', {
        serial,
        verificationStatus: result.verification_status,
        verified: result.verified,
        sku: result.sku,
        routeKind: 'authenticity',
      })
    } catch (error) {
      const message = toUserMessage(error, 'Serial verification failed.')
      setVerifyError(message)
      trackStorefrontEvent('verification_failed', { serial, message, routeKind: 'authenticity' })
    } finally {
      setVerifyLoading(false)
    }
  }

  return (
    <main id="main-content" className="storefront authenticity-page">
      <div className="container">
        <div className="storefront-shell">
          <section className="top-hero authenticity-hero">
            <SiteNav mode="light" />

            <div className="authenticity-hero__panel gtg-panel">
              <div className="authenticity-hero__copy">
                <p className="authenticity-hero__eyebrow">Licensing & Authenticity</p>
                <Heading as="h1" className="authenticity-hero__title">
                  Official, licensed, and easy to verify.
                </Heading>
                <p className="authenticity-hero__lead">
                  Every collectible is built around approved marks, official school colors,
                  and a registered hologram serial that can be checked at any time.
                </p>
                <div className="authenticity-hero__chips" role="list" aria-label="Authenticity highlights">
                  <span role="listitem" className="gtg-pill">Official NCAA / CLC licensing</span>
                  <span role="listitem" className="gtg-pill">Registered hologram serial</span>
                  <span role="listitem" className="gtg-pill">Gift-ready collectible presentation</span>
                </div>
              </div>

              <div className="authenticity-hero__summary">
                <span className="authenticity-hero__summary-label">What This Covers</span>
                <strong>Official marks, color approvals, and serial-backed verification.</strong>
                <p>
                  This page is the trust hub for how Game Time Gift products are licensed,
                  tracked, and confirmed as authentic.
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="home-band-inner">
          <section className="authenticity-layout" aria-label="Authenticity details">
            <article className="authenticity-card authenticity-card--verify gtg-card">
              <p className="authenticity-card__eyebrow">Verify Authenticity</p>
              <Heading as="h2" className="authenticity-card__title">
                Check the hologram serial.
              </Heading>
              <p className="authenticity-card__body">
                Enter the code from your product hologram to confirm the item is registered,
                licensed, and tied to its order record.
              </p>

              <form
                className="verify-form authenticity-verify-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void onVerify()
                }}
              >
                <input
                  type="text"
                  className="gtg-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="GTG-HOLO-0001"
                  autoComplete="off"
                  aria-label="Hologram code"
                />
                <Button type="submit" variant="primary" disabled={verifyLoading}>
                  {verifyLoading ? 'Verifying...' : 'Verify Authenticity'}
                </Button>
              </form>

              {verifyError ? <AlertBanner kind="error">{verifyError}</AlertBanner> : null}

              {verifyResult ? (
                <article className="verify-result" aria-live="polite">
                  <p><strong>Result:</strong> {verifyResult.verified ? 'Verified' : 'Not verified'}</p>
                  <p><strong>Status:</strong> {verifyResult.verification_status}</p>
                  <p><strong>Serial:</strong> {verifyResult.serial_number}</p>
                  <p><strong>Product:</strong> {verifyResult.product_name} ({verifyResult.sku})</p>
                  <p><strong>License:</strong> {verifyResult.license_body}</p>
                </article>
              ) : null}
            </article>

            <article className="authenticity-card gtg-card">
              <p className="authenticity-card__eyebrow">What Makes It Official</p>
              <Heading as="h2" className="authenticity-card__title">
                Licensed marks, colors, and approvals.
              </Heading>
              <p className="authenticity-card__body">
                NCAA products are produced through approved Collegiate Licensing Company standards,
                using school-authorized logos, marks, and color direction. Military products follow
                their own approved marks and collection standards.
              </p>
              <div className="authenticity-card__pills" role="list" aria-label="Official licensing details">
                <span role="listitem" className="gtg-pill">Official NCAA / CLC</span>
                <span role="listitem" className="gtg-pill">Approved school marks</span>
                <span role="listitem" className="gtg-pill">Color-matched by license</span>
              </div>
            </article>

            <article className="authenticity-card gtg-card">
              <p className="authenticity-card__eyebrow">How Verification Works</p>
              <Heading as="h2" className="authenticity-card__title">
                One serial, one order-linked record.
              </Heading>
              <p className="authenticity-card__body">
                Each piece ships with a registered hologram serial number. That code can be used to
                confirm authenticity, licensing, and provenance long after the original gifting moment.
              </p>
              <ol className="authenticity-card__steps" aria-label="Verification steps">
                <li>Find the hologram code on the product.</li>
                <li>Enter it in the verification field.</li>
                <li>See the item and registration status instantly.</li>
              </ol>
            </article>

            <article className="authenticity-card authenticity-card--faq gtg-card">
              <p className="authenticity-card__eyebrow">FAQ</p>
              <Heading as="h2" className="authenticity-card__title">
                The trust questions buyers ask most.
              </Heading>
              <dl className="authenticity-faq">
                <div>
                  <dt>Are these officially NCAA licensed?</dt>
                  <dd>Yes. NCAA pieces use approved marks, logos, and color standards through NCAA / CLC licensing.</dd>
                </div>
                <div>
                  <dt>Where do I find the hologram code?</dt>
                  <dd>Each authentic piece includes a hologram serial placed with the product for easy lookup.</dd>
                </div>
                <div>
                  <dt>What does verification confirm?</dt>
                  <dd>It confirms the serial record, item registration, and authenticity status tied to that collectible.</dd>
                </div>
              </dl>
            </article>
          </section>
        </div>

        <div className="home-band-inner">
          <section className="authenticity-bottom-cta gtg-panel" aria-label="Continue shopping">
            <div>
              <p className="authenticity-bottom-cta__eyebrow">Shop With Confidence</p>
              <h2>Browse the collection with the trust story settled.</h2>
              <p>
                Once buyers understand the licensing and serial process, the rest of the site can stay
                cleaner and more product-focused.
              </p>
            </div>
            <Link to="/shop" className="gtg-btn gtg-btn--gold gtg-btn--lg">
              Shop the Collection
            </Link>
          </section>
        </div>

        <Suspense fallback={null}>
          <StorefrontFooter />
        </Suspense>
      </div>
    </main>
  )
}
