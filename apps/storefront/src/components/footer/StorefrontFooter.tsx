import { Heading } from '@gtg/ui'
import { STOREFRONT_FOOTER_CONFIG } from '../../config/footer'
import visaLogo from '../../assets/visa.png'
import mastercardLogo from '../../assets/mastercard.png'
import amexLogo from '../../assets/american_express.png'
import discoverLogo from '../../assets/discover.png'
import paypalLogo from '../../assets/pay_pay.png'
import applePayLogo from '../../assets/apple_pay.jpg'
import facebookLogo from '../../assets/facebook.png'
import instagramLogo from '../../assets/insta_gram.png'
import tiktokLogo from '../../assets/tiktok.png'
import youtubeLogo from '../../assets/you_tube.png'

const SOCIAL_ICON_SRC: Record<(typeof STOREFRONT_FOOTER_CONFIG.social)[number]['icon'], string> = {
  instagram: instagramLogo,
  facebook: facebookLogo,
  youtube: youtubeLogo,
  tiktok: tiktokLogo,
}

const PAYMENT_MARKS = [
  { id: 'visa', label: 'Visa', src: visaLogo },
  { id: 'mastercard', label: 'Mastercard', src: mastercardLogo },
  { id: 'amex', label: 'American Express', src: amexLogo },
  { id: 'discover', label: 'Discover', src: discoverLogo },
  { id: 'paypal', label: 'PayPal', src: paypalLogo },
  { id: 'applepay', label: 'Apple Pay', src: applePayLogo },
] as const

export function StorefrontFooter() {
  return (
    <footer className="gtg-footer" aria-label="Game Time Gift footer">
      <section className="gtg-footer-main" aria-label="Footer navigation">
        <section className="gtg-footer-intro" aria-label="Footer introduction">
          <p className="gtg-footer-kicker">Curated Sports Gifting</p>
          <Heading as="h3" display={false}>Display-worthy pieces for fans who notice the details.</Heading>
          <p>Officially licensed collectibles with a cleaner, gift-first feel from browse to unboxing.</p>
        </section>

        <div className="gtg-footer-columns">
          {STOREFRONT_FOOTER_CONFIG.columns.map((column) => (
            <section key={column.id} className="gtg-footer-col" aria-label={column.title}>
              <Heading as="h3" display={false}>{column.title}</Heading>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                    {link.description ? <p>{link.description}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <aside className="gtg-footer-utility" aria-label="Newsletter and social">
          <Heading as="h3" display={false}>Stay in the loop</Heading>
          <p>{STOREFRONT_FOOTER_CONFIG.newsletter.subtitle}</p>
          <a href={STOREFRONT_FOOTER_CONFIG.newsletter.ctaHref} className="gtg-footer-newsletter-cta">
            Join the List
          </a>

          <div className="gtg-footer-social">
            <h4>Follow the brand</h4>
            <ul>
              {STOREFRONT_FOOTER_CONFIG.social.map((social) => (
                <li key={social.label}>
                  <a href={social.href} target="_blank" rel="noreferrer" aria-label={social.label}>
                    <img src={SOCIAL_ICON_SRC[social.icon]} alt={social.label} loading="lazy" />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="gtg-footer-payments" aria-label="Accepted payments">
            <h4>Fast checkout</h4>
            <ul>
              {PAYMENT_MARKS.map((mark) => (
                <li key={mark.id} className={`gtg-payment-chip ${mark.id}`} aria-label={mark.label}>
                  <img src={mark.src} alt={mark.label} loading="lazy" />
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </section>

      <section className="gtg-footer-legal" aria-label="Legal links and copyright">
        <nav aria-label="Legal links">
          <ul>
            {STOREFRONT_FOOTER_CONFIG.legal.map((link) => (
              <li key={link.label}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <p>{STOREFRONT_FOOTER_CONFIG.copyright}</p>
      </section>
    </footer>
  )
}
