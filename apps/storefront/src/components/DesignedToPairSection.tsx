import { trackStorefrontEvent } from '../analytics'

const PURCHASE_OPTIONS = [
  {
    id: 'vase-only',
    step: '01',
    title: 'Vase Only',
    body: 'The cleanest collectible presentation for shelves, desks, and standalone display.',
    tag: 'Core Piece',
    highlight: 'Minimal and collectible',
    price: '$139.00',
    details: ['Standalone vase purchase', 'Best for display-first buyers'],
  },
  {
    id: 'vase-flowers',
    step: '02',
    title: 'Vase + Flowers',
    body: 'A fully gift-ready presentation with floral styling built around the collectible vase.',
    tag: 'Recommended',
    highlight: 'Most gift-ready',
    price: '$179-$189',
    details: ['Classic Rose Arrangement', 'Rose + Carnation Arrangement'],
  },
  {
    id: 'vase-humidor',
    step: '03',
    title: 'Vase + Cigar Humidor',
    body: 'A richer premium pairing for milestone gifting, office display, and elevated host moments.',
    tag: 'Premium Bundle',
    highlight: 'For higher-ticket gifting',
    price: '$179.00',
    details: ['Bundle presentation', 'Built for premium recipients'],
  },
] as const

export function DesignedToPairSection() {
  return (
    <section className="designed-to-pair" aria-label="Purchase options">
      <div className="dtp-inner">
        <div className="dtp-head">
          <p className="dtp-eyebrow">Purchase Paths</p>
          <h2 className="dtp-title">Choose how you want to buy it.</h2>
          <p className="dtp-subhead">
            Three cleaner purchase formats built around the same collectible centerpiece.
          </p>
        </div>

        <div className="dtp-pairing-grid">
          {PURCHASE_OPTIONS.map((option) => (
            <article
              key={option.id}
              className={`dtp-pairing-card ${option.id === 'vase-flowers' ? 'dtp-pairing-card--featured' : ''}`}
            >
              <div className="dtp-pairing-topline">
                <span className="dtp-pairing-step" aria-hidden="true">
                  {option.step}
                </span>
                <span className="dtp-pairing-tag">{option.tag}</span>
              </div>
              <h3 className="dtp-pairing-headline">{option.title}</h3>
              <p className="dtp-pairing-highlight">{option.highlight}</p>
              <p className="dtp-pairing-price">{option.price}</p>
              <p className="dtp-pairing-body">{option.body}</p>
              <div className="dtp-option-list" aria-label={`${option.title} details`}>
                {option.details.map((detail) => (
                  <span key={detail} className="dtp-option-chip">
                    {detail}
                  </span>
                ))}
              </div>
              <a href="#gift-flow" className="dtp-option-cta">
                Choose This Option
              </a>
            </article>
          ))}
        </div>

        <div className="dtp-cta-row">
          <p className="dtp-cta-copy">
            The floral route includes two arrangement choices: Classic Rose or Rose + Carnation.
          </p>
          <a
            href="#catalog"
            className="gtg-btn gtg-btn--gold gtg-btn--lg dtp-cta-button"
            onClick={() => trackStorefrontEvent('partner_cta_clicked', {
              optionCount: PURCHASE_OPTIONS.length,
              destination: 'catalog',
            })}
          >
            Explore the Collection
          </a>
        </div>
      </div>
    </section>
  )
}
