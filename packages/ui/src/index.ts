/* ─────────────────────────────────────────────────────────────
   @gtg/ui — Component Library  (index.ts)

   Exports raw React components compiled by the consuming app's
   Vite build. No build step required in this package.

   CSS IMPORT ORDER (in each app entry point):
     import '@gtg/ui/fonts.css'
     import '@gtg/ui/tokens.css'
     import '@gtg/ui/components.css'

   Components exported:
     Utility:     cx
     Primitives:  Button, Badge, Heading
     Composed:    ProductCard, BasicProductCard, Header
     Layout:      Container, SectionCard, SectionIntro, EmptyState
     Feedback:    InlineMessage, AlertBanner
     Branding:    TrustItem
   ───────────────────────────────────────────────────────────── */

import {
  createElement,
  Fragment,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type SVGAttributes,
} from 'react'


// ═══════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════

export type CxValue = string | number | null | false | undefined

/**
 * Lightweight classname joiner. Filters falsy values.
 * Usage: cx('base', isActive && 'active', className)
 */
export function cx(...values: CxValue[]): string {
  return values
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ')
}

// ── Internal spinner SVG ─────────────────────────────────────
// Used only by Button when loading=true.

function SpinnerIcon(props: SVGAttributes<SVGElement>) {
  return createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
      ...props,
    },
    createElement('circle', {
      cx: '8',
      cy: '8',
      r: '6',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeOpacity: '0.25',
    }),
    createElement('path', {
      d: 'M14 8a6 6 0 0 0-6-6',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
    }),
  )
}


// ═══════════════════════════════════════════════════════════
// CONTAINER
// ═══════════════════════════════════════════════════════════

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children: ReactNode
}

export function Container(props: ContainerProps) {
  const { size = 'lg', className, children, ...rest } = props
  return createElement(
    'div',
    {
      ...rest,
      className: cx('gtg-container', `gtg-container--${size}`, className),
    },
    children,
  )
}


// ═══════════════════════════════════════════════════════════
// BUTTON
// ═══════════════════════════════════════════════════════════

/**
 * Button — primary interactive element.
 *
 * VARIANTS
 *   primary   — navy gradient, white text. Main CTAs.
 *   secondary — white bg, bordered. Supporting actions.
 *   ghost     — transparent bg. Tertiary / icon actions.
 *   gold      — gold gradient, navy text. Premium CTAs.
 *   danger    — dark red. Destructive actions.
 *
 * SIZES
 *   sm  — 32px min-height. Compact UI, inline actions.
 *   md  — 44px min-height (WCAG). Default.
 *   lg  — 52px min-height. Hero CTAs, primary checkout.
 *
 * STATES
 *   default   — resting style per variant
 *   hover     — brightness increase + shadow lift + translateY(-1px)
 *   active    — translateY(1px) + scale(0.985) — press feedback
 *   focus     — :focus-visible offset ring, never on mouse click
 *   disabled  — 50% opacity, cursor not-allowed, pointer-events none
 *   loading   — spinner replaces leading icon, aria-busy, cursor wait
 *
 * ACCESSIBILITY
 *   - Always rendered as <button type="button"> unless type="submit"
 *   - loading sets aria-busy="true" and aria-label carries context
 *   - disabled: prefer the disabled HTML attr over aria-disabled
 *     (HTML attr prevents focus; aria-disabled still focusable)
 *   - Color contrast: all variants ≥ 4.5:1 WCAG AA
 *
 * USAGE
 *   <Button variant="primary" size="lg" onClick={handleCheckout}>
 *     Complete Purchase
 *   </Button>
 *
 *   <Button variant="gold" loading={isSubmitting} type="submit">
 *     Add to Cart
 *   </Button>
 *
 *   <Button variant="danger" disabled>
 *     Remove Item
 *   </Button>
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Default: 'primary' */
  variant?: 'primary' | 'secondary' | 'ghost' | 'gold' | 'danger'
  /** Size token. Default: 'md' */
  size?: 'sm' | 'md' | 'lg'
  /**
   * When true: shows spinner, sets aria-busy, blocks interaction.
   * aria-label on the button should describe the in-progress action
   * for screen readers: e.g. aria-label="Adding to cart…"
   */
  loading?: boolean
  children: ReactNode
}

export function Button(props: ButtonProps) {
  const {
    variant = 'primary',
    size = 'md',
    loading = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  } = props

  const isDisabled = disabled || loading

  return createElement(
    'button',
    {
      ...rest,
      type,
      disabled: isDisabled,
      'aria-busy': loading ? 'true' : undefined,
      className: cx(
        'gtg-btn',
        `gtg-btn--${variant}`,
        `gtg-btn--${size}`,
        loading && 'gtg-btn--loading',
        className,
      ),
    },
    loading
      ? createElement(
          'span',
          { className: 'gtg-btn__spinner' },
          createElement(SpinnerIcon),
        )
      : null,
    createElement('span', { className: 'gtg-btn__label' }, children),
  )
}


// ═══════════════════════════════════════════════════════════
// BADGE
// ═══════════════════════════════════════════════════════════

/**
 * Badge — compact label chip. Display-only; never interactive.
 *
 * VARIANTS
 *   licensed  — gold tint. Official licensed merchandise.
 *   sport     — navy tint. Sport category (NFL, NBA, etc.).
 *   occasion  — neutral grey. Gift occasion context.
 *   neutral   — default grey. General purpose.
 *   success   — green. Availability, confirmations.
 *   error     — red. Out-of-stock, compliance flags.
 *   warning   — amber. Low stock, caution notices.
 *
 * STATES
 *   Badges have no interactive states — they are purely display.
 *   For a clickable chip/filter, use Button variant="ghost" instead.
 *
 * VISUAL RULES
 *   - Pill shape (border-radius: full)
 *   - Font: Inter 700, uppercase, tracking-wider (0.06em)
 *   - Font size: text-xs (12px)
 *   - Padding: 0.2rem 0.6rem
 *   - Never wraps (white-space: nowrap)
 *
 * ACCESSIBILITY
 *   - Rendered as <span> — inline text semantics
 *   - Color is supplemented by text content (never sole indicator)
 *   - role="status" can be added by consumer for live-updating badges
 *
 * USAGE
 *   <Badge variant="licensed">NFL</Badge>
 *   <Badge variant="sport">Football</Badge>
 *   <Badge variant="success">In Stock</Badge>
 *   <Badge variant="error">Sold Out</Badge>
 *   <Badge variant="warning">2 Left</Badge>
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Visual variant. Default: 'neutral' */
  variant?: 'licensed' | 'sport' | 'occasion' | 'neutral' | 'success' | 'error' | 'warning'
  children: ReactNode
}

export function Badge(props: BadgeProps) {
  const { variant = 'neutral', className, children, ...rest } = props
  return createElement(
    'span',
    { ...rest, className: cx('gtg-badge', `gtg-badge--${variant}`, className) },
    children,
  )
}


// ═══════════════════════════════════════════════════════════
// PRODUCT CARD
// ═══════════════════════════════════════════════════════════

/**
 * ProductCard — clickable card for a single licensed product.
 *
 * VARIANTS
 *   default  — standard layout with 4:3 image ratio, full body.
 *   compact  — 16:9 image ratio, tighter body, 1-line name clamp.
 *              Use in carousels / dense grids.
 *
 * STATES
 *   default  — resting: light shadow, white background.
 *   hover    — shadow-card-hover + translateY(-3px) + image scale.
 *   active   — translateY(-1px) + scale(0.99) — press feedback.
 *   focus    — :focus-visible offset ring outside card border.
 *   disabled — 55% opacity, cursor not-allowed.
 *
 * PROPS
 *   name           Product name (required). Used as image alt fallback.
 *   sport          Sport category string — renders sport Badge.
 *   licenseBody    License body name (NFL, NBA…) — renders licensed Badge.
 *   priceCents     Price in smallest currency unit (cents). Required.
 *   hologramVerified  If true: shows gold "Verified" stamp on image.
 *   imageUrl       Product image URL. Falls back to placeholder trophy.
 *   compact        Renders compact variant.
 *   disabled       Renders disabled state, blocks onClick.
 *   onClick        Click handler. Receives MouseEvent<HTMLButtonElement>.
 *   className      Extra CSS classes applied to the root element.
 *   ariaLabel      Override accessible name. Defaults to product name.
 *                  Recommended: include price for full context,
 *                  e.g. "Chicago Bulls Jersey – $49.99"
 *
 * LAYOUT STRUCTURE
 *   <button class="gtg-product-card [gtg-product-card--compact]">
 *     <div class="gtg-product-card__image-wrap">
 *       <img | placeholder />
 *       <span class="gtg-product-card__hologram-badge" />  (optional)
 *     </div>
 *     <div class="gtg-product-card__body">
 *       <div class="gtg-product-card__badges">…</div>     (optional)
 *       <p class="gtg-product-card__name">…</p>
 *       <div class="gtg-product-card__meta">
 *         <span class="gtg-product-card__price">…</span>
 *         <span class="gtg-product-card__license">…</span> (optional)
 *       </div>
 *     </div>
 *   </button>
 *
 * ACCESSIBILITY
 *   - Rendered as <button type="button"> for full keyboard support.
 *   - Image must have descriptive alt text (name is the minimum).
 *   - Hologram badge and placeholder icon are aria-hidden.
 *   - Provide ariaLabel for richer screen reader context.
 *   - :focus-visible ring is clearly visible (≥ 3:1 contrast).
 *
 * USAGE
 *   <ProductCard
 *     name="Chicago Bulls Retro Jersey"
 *     sport="Basketball"
 *     licenseBody="NBA"
 *     priceCents={4999}
 *     hologramVerified
 *     imageUrl="/products/bulls-jersey.jpg"
 *     ariaLabel="Chicago Bulls Retro Jersey – $49.99"
 *     onClick={() => router.push('/products/bulls-jersey')}
 *   />
 *
 *   <ProductCard
 *     name="Mini Football Helmet"
 *     sport="Football"
 *     licenseBody="NFL"
 *     priceCents={2499}
 *     compact
 *     onClick={handleSelect}
 *   />
 */
export interface ProductCardProps {
  /** Product name. Required. Also used as image alt text fallback. */
  name: string
  /** Sport category. Renders a sport Badge when provided. */
  sport?: string
  /** Licensing body (NFL, NBA, MLB…). Renders licensed Badge when provided. */
  licenseBody?: string
  /** Price in cents (integer). Required. */
  priceCents: number
  /** When true: shows gold "Verified" hologram stamp on the image. */
  hologramVerified?: boolean
  /** Product image URL. Falls back to a trophy placeholder when omitted. */
  imageUrl?: string
  /** Override image alt text. Defaults to `name`. */
  imageAlt?: string
  /** Extra CSS classes on the image frame. */
  imageWrapClassName?: string
  /** Extra CSS classes on the image element. */
  imageClassName?: string
  /** Override the default badge row. */
  badges?: ReactNode
  /** Supporting content between the title and price row. */
  details?: ReactNode
  /** Supplemental content rendered beside the price. */
  priceTrailing?: ReactNode
  /** CTA copy displayed at the bottom of the card. */
  actionLabel?: string
  /** CTA tone for the bottom action row. */
  actionVariant?: 'primary' | 'secondary' | 'ghost' | 'gold'
  /** Renders compact variant (16:9 image, tighter padding, 1-line name). */
  compact?: boolean
  /** Optional href. When provided, the card renders as a link. */
  href?: string
  /** Disables the card: blocks onClick, reduces opacity, changes cursor. */
  disabled?: boolean
  /** Click handler. */
  onClick?: (e: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void
  /**
   * Accessible label override. Defaults to `name`.
   * Recommended: include price for full context, e.g. "Bulls Jersey – $49.99"
   */
  ariaLabel?: string
  /** Extra CSS classes on the root <button>. */
  className?: string
}

function formatPrice(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

export function ProductCard(props: ProductCardProps) {
  const {
    name,
    sport,
    licenseBody,
    priceCents,
    hologramVerified = false,
    imageUrl,
    imageAlt,
    imageWrapClassName,
    imageClassName,
    badges,
    details,
    priceTrailing,
    actionLabel,
    actionVariant = 'primary',
    compact = false,
    href,
    disabled = false,
    onClick,
    ariaLabel,
    className,
  } = props

  const imageWrap = createElement(
    'div',
    { className: cx('gtg-product-card__image-wrap', imageWrapClassName) },
    imageUrl
      ? createElement('img', {
          src: imageUrl,
          alt: imageAlt ?? name,
          loading: 'lazy' as const,
          decoding: 'async' as const,
          className: imageClassName,
        })
      : createElement(
          'div',
          { className: 'gtg-product-card__image-placeholder', 'aria-hidden': 'true' },
          '🏆',
        ),
    hologramVerified
      ? createElement(
          'span',
          { className: 'gtg-product-card__hologram-badge', 'aria-hidden': 'true' },
          'Verified',
        )
      : null,
  )

  const generatedBadges = [
    sport
      ? createElement(Badge, { key: 'sport', variant: 'sport' as const, children: sport })
      : null,
    licenseBody
      ? createElement(Badge, { key: 'lic', variant: 'licensed' as const, children: licenseBody })
      : null,
  ].filter(Boolean)

  const body = createElement(
    'div',
    { className: 'gtg-product-card__body' },
    badges ?? generatedBadges.length > 0
      ? createElement(
          'div',
          { className: 'gtg-product-card__badges' },
          badges ?? createElement(Fragment, null, ...generatedBadges),
        )
      : null,
    createElement('p', { className: 'gtg-product-card__name' }, name),
    details
      ? createElement('div', { className: 'gtg-product-card__details' }, details)
      : null,
    createElement(
      'div',
      { className: 'gtg-product-card__meta' },
      createElement(
        'span',
        { className: 'gtg-product-card__price' },
        formatPrice(priceCents),
      ),
      priceTrailing
        ? createElement(
            'span',
            { className: 'gtg-product-card__license', 'aria-hidden': 'true' },
            priceTrailing,
          )
        : null,
    ),
    actionLabel
      ? createElement(
          'span',
          {
            className: cx(
              'gtg-product-card__action',
              `gtg-product-card__action--${actionVariant}`,
            ),
          },
          actionLabel,
        )
      : null,
  )

  const sharedProps = {
    className: cx(
      'gtg-product-card',
      compact && 'gtg-product-card--compact',
      className,
    ),
    onClick: disabled ? undefined : onClick,
    'aria-disabled': disabled ? 'true' : undefined,
    'aria-label': ariaLabel ?? name,
  }

  if (href) {
    return createElement(
      'a',
      {
        ...sharedProps,
        href,
      },
      imageWrap,
      body,
    )
  }

  return createElement(
    'button',
    {
      ...sharedProps,
      type: 'button' as const,
      disabled,
    },
    imageWrap,
    body,
  )
}


// ═══════════════════════════════════════════════════════════
// BASIC PRODUCT CARD
// ═══════════════════════════════════════════════════════════

export interface BasicProductCardProps extends HTMLAttributes<HTMLElement> {
  title: string
  description?: ReactNode
  imageUrl?: string
  href?: string
  ctaLabel?: string
}

export function BasicProductCard(props: BasicProductCardProps) {
  const {
    title,
    description,
    imageUrl,
    href,
    ctaLabel = 'Open',
    className,
    ...rest
  } = props

  const media = createElement(
    'div',
    { className: 'gtg-basic-product-card__media', 'aria-hidden': 'true' },
    imageUrl
      ? createElement('img', {
          src: imageUrl,
          alt: '',
          loading: 'lazy' as const,
          decoding: 'async' as const,
        })
      : createElement('span', { className: 'gtg-basic-product-card__placeholder' }, 'Product'),
  )

  const body = createElement(
    'div',
    { className: 'gtg-basic-product-card__body' },
    createElement('h3', { className: 'gtg-basic-product-card__title' }, title),
    description
      ? createElement('p', { className: 'gtg-basic-product-card__description' }, description)
      : null,
    createElement('span', { className: 'gtg-basic-product-card__cta' }, ctaLabel),
  )

  if (href) {
    return createElement(
      'a',
      {
        ...rest,
        href,
        className: cx('gtg-basic-product-card', className),
      },
      media,
      body,
    )
  }

  return createElement(
    'article',
    {
      ...rest,
      className: cx('gtg-basic-product-card', className),
    },
    media,
    body,
  )
}


// ═══════════════════════════════════════════════════════════
// HEADING
// ═══════════════════════════════════════════════════════════

/**
 * Heading — semantic heading element with design system scale.
 *
 * VARIANTS (by level)
 *   h1  — hero / page title. clamp(2.25rem, 5vw, 3.75rem). Weight 800.
 *   h2  — section heading. clamp(1.75rem, 3.5vw, 2.25rem). Weight 700.
 *   h3  — subsection. clamp(1.25rem, 2.5vw, 1.5rem). Weight 700.
 *   h4  — card / component heading. 1.125rem. Weight 700.
 *
 * FONT MODIFIERS
 *   display=true  — Playfair Display (default for h1–h3)
 *   display=false — Inter (always for h4, override for h1–h3)
 *
 * ADDITIONAL MODIFIERS (via props)
 *   italic  — Playfair italic. Decorative use only.
 *   align   — 'left' (default) | 'center' | 'right'
 *   muted   — ink-500 color. For secondary headings.
 *
 * STATES
 *   Static display element. No interactive states.
 *   When inside an <a>: the anchor handles all interaction.
 *
 * VISUAL RULES
 *   - margin: 0 always. Outer spacing is the consumer's responsibility.
 *   - Color: --color-ink-900 default; --color-ink-500 when muted.
 *   - Letter spacing: tighter on large headings (negative), normal for h3–h4.
 *   - -webkit-font-smoothing: antialiased always.
 *
 * ACCESSIBILITY
 *   - Must use semantic h1–h4 tags (as prop controls the element tag).
 *   - One h1 per page — enforced by convention, not by this component.
 *   - Never skip heading levels in document flow.
 *   - Visual display class does NOT change semantic level.
 *   - Text must not rely on color alone to convey meaning.
 *
 * USAGE
 *   <Heading as="h1" display italic align="center">
 *     The Perfect Game Day Gift
 *   </Heading>
 *
 *   <Heading as="h2">Shop by Sport</Heading>
 *
 *   <Heading as="h3" display={false}>Order Summary</Heading>
 *
 *   <Heading as="h4" muted>Related Products</Heading>
 */
export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** HTML element to render. Default: 'h2' */
  as?: 'h1' | 'h2' | 'h3' | 'h4'
  /**
   * When true: uses Playfair Display (serif).
   * When false: uses Inter (sans-serif).
   * Default: true for h1–h3, false for h4.
   */
  display?: boolean
  /** Renders Playfair italic. Use only with display=true. */
  italic?: boolean
  /** Text alignment. Default: 'left' (inherited). */
  align?: 'left' | 'center' | 'right'
  /** Muted color (ink-500). For secondary headings. */
  muted?: boolean
  children: ReactNode
}

export function Heading(props: HeadingProps) {
  const {
    as: tag = 'h2',
    display,
    italic = false,
    align,
    muted = false,
    className,
    children,
    ...rest
  } = props

  const level = tag.slice(1) // '1' | '2' | '3' | '4'
  // h4 defaults to body font; h1–h3 default to display font
  const useDisplay = display ?? level !== '4'

  return createElement(
    tag,
    {
      ...rest,
      className: cx(
        'gtg-heading',
        `gtg-heading--${level}`,
        useDisplay ? 'gtg-heading--display' : 'gtg-heading--body',
        italic && 'gtg-heading--italic',
        align === 'center' && 'gtg-heading--center',
        align === 'right' && 'gtg-heading--right',
        muted && 'gtg-heading--muted',
        className,
      ),
    },
    children,
  )
}


// ═══════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════

export interface HeaderLinkItem {
  href: string
  label: string
}

export interface HeaderProps extends HTMLAttributes<HTMLElement> {
  brandLabel: string
  brandHref: string
  logoSrc?: string
  links?: HeaderLinkItem[]
  actions?: ReactNode
}

export function Header(props: HeaderProps) {
  const {
    brandLabel,
    brandHref,
    logoSrc,
    links = [],
    actions,
    className,
    ...rest
  } = props

  return createElement(
    'header',
    {
      ...rest,
      className: cx('gtg-header', className),
    },
    createElement(
      'a',
      {
        href: brandHref,
        className: 'gtg-header__brand',
        'aria-label': brandLabel,
      },
      logoSrc
        ? createElement('img', {
            src: logoSrc,
            alt: '',
            className: 'gtg-header__logo',
          })
        : null,
      createElement('span', { className: 'gtg-header__brand-label' }, brandLabel),
    ),
    createElement(
      'nav',
      {
        className: 'gtg-header__nav',
        'aria-label': 'Primary navigation',
      },
      links.map((link) =>
        createElement(
          'a',
          {
            key: link.href,
            href: link.href,
            className: 'gtg-header__link',
          },
          link.label,
        ),
      ),
    ),
    actions
      ? createElement('div', { className: 'gtg-header__actions' }, actions)
      : null,
  )
}


// ═══════════════════════════════════════════════════════════
// SECTION CARD
// ═══════════════════════════════════════════════════════════

/**
 * SectionCard — bordered panel with an optional tone tint.
 *
 * USAGE
 *   <SectionCard heading="Shipping Details" tone="positive">
 *     …
 *   </SectionCard>
 */
export interface SectionCardProps extends HTMLAttributes<HTMLElement> {
  heading: string
  tone?: 'neutral' | 'positive' | 'warning'
  children: ReactNode
}

export function SectionCard(props: SectionCardProps) {
  const { heading, tone = 'neutral', className, children, ...rest } = props
  return createElement(
    'section',
    { ...rest, className: cx('gtg-section-card', `tone-${tone}`, className) },
    createElement('h3', null, heading),
    children,
  )
}


// ═══════════════════════════════════════════════════════════
// INLINE MESSAGE
// ═══════════════════════════════════════════════════════════

/**
 * InlineMessage — single-line contextual message inside a form or panel.
 *
 * USAGE
 *   <InlineMessage kind="error">Card number is invalid.</InlineMessage>
 *   <InlineMessage kind="success">Order confirmed!</InlineMessage>
 */
export interface InlineMessageProps extends HTMLAttributes<HTMLParagraphElement> {
  kind?: 'info' | 'error' | 'success'
  children: ReactNode
}

export function InlineMessage(props: InlineMessageProps) {
  const { kind = 'info', className, children, ...rest } = props
  return createElement(
    'p',
    { ...rest, className: cx('gtg-inline-message', `kind-${kind}`, className) },
    children,
  )
}


// ═══════════════════════════════════════════════════════════
// ALERT BANNER
// ═══════════════════════════════════════════════════════════

/**
 * AlertBanner — full-width status banner with optional action button.
 *
 * USAGE
 *   <AlertBanner kind="error" actionLabel="Retry" onAction={retry}>
 *     Payment failed. Please try again.
 *   </AlertBanner>
 */
export interface AlertBannerProps extends HTMLAttributes<HTMLDivElement> {
  kind?: 'info' | 'error' | 'success'
  actionLabel?: string
  onAction?: (() => void) | undefined
  children: ReactNode
}

export function AlertBanner(props: AlertBannerProps) {
  const { kind = 'info', actionLabel, onAction, className, children, ...rest } = props
  return createElement(
    'div',
    {
      ...rest,
      className: cx('gtg-alert-banner', `gtg-alert-banner--${kind}`, className),
      role: kind === 'error' ? 'alert' : 'status',
    },
    createElement('span', { className: 'gtg-alert-banner__content' }, children),
    actionLabel && onAction
      ? createElement(
          'button',
          {
            type: 'button' as const,
            className: 'gtg-alert-banner__action',
            onClick: onAction,
          },
          actionLabel,
        )
      : null,
  )
}


// ═══════════════════════════════════════════════════════════
// SECTION INTRO
// ═══════════════════════════════════════════════════════════

/**
 * SectionIntro — eyebrow + title + description block.
 *
 * USAGE
 *   <SectionIntro
 *     eyebrow="Our Collection"
 *     title="Shop by Sport"
 *     description="Find officially licensed gear for every fan."
 *   />
 */
export interface SectionIntroProps extends HTMLAttributes<HTMLDivElement> {
  eyebrow?: string
  title: string
  description?: ReactNode
  titleAs?: 'h1' | 'h2' | 'h3'
}

export function SectionIntro(props: SectionIntroProps) {
  const { eyebrow, title, description, titleAs = 'h2', className, ...rest } = props

  return createElement(
    'div',
    { ...rest, className: cx('gtg-section-intro', className) },
    eyebrow
      ? createElement('p', { className: 'gtg-section-intro__eyebrow' }, eyebrow)
      : null,
    createElement(titleAs, { className: 'gtg-section-intro__title' }, title),
    description
      ? createElement('div', { className: 'gtg-section-intro__description' }, description)
      : null,
  )
}


// ═══════════════════════════════════════════════════════════
// EMPTY STATE
// ═══════════════════════════════════════════════════════════

/**
 * EmptyState — placeholder for empty collections or zero-results.
 *
 * USAGE
 *   <EmptyState
 *     title="No products found"
 *     description="Try adjusting your filters."
 *     hint="Or browse all sports."
 *   />
 */
export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  title: string
  description: ReactNode
  hint?: ReactNode
}

export function EmptyState(props: EmptyStateProps) {
  const { title, description, hint, className, ...rest } = props
  return createElement(
    'div',
    { ...rest, className: cx('gtg-empty-state', className) },
    createElement('strong', { className: 'gtg-empty-state__title' }, title),
    createElement('p', { className: 'gtg-empty-state__description' }, description),
    hint
      ? createElement('p', { className: 'gtg-empty-state__hint' }, hint)
      : null,
  )
}


// ═══════════════════════════════════════════════════════════
// TRUST ITEM
// ═══════════════════════════════════════════════════════════

/**
 * TrustItem — icon + label pair for trust/guarantee signals.
 *
 * USAGE
 *   <TrustItem icon="🔒" label="Secure Checkout" />
 *   <TrustItem icon="✅" label="100% Licensed Merchandise" />
 */
export interface TrustItemProps extends HTMLAttributes<HTMLDivElement> {
  icon: string
  label: string
}

export function TrustItem(props: TrustItemProps) {
  const { icon, label, className, ...rest } = props
  return createElement(
    'div',
    { ...rest, className: cx('gtg-trust-item', className) },
    createElement('span', { className: 'gtg-trust-item__icon', 'aria-hidden': 'true' }, icon),
    createElement('span', { className: 'gtg-trust-item__label' }, label),
  )
}
