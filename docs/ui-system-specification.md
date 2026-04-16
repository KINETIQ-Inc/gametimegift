# UI System Specification

**Game Time Gift — All Applications**
Authoritative reference for storefront, consultant portal, and admin portal UI.
Every screen, flow, component, and data contract is defined here.

---

## 1. Sitemap

### Storefront (`apps/storefront`, port 3000)

| URL | Page | Purpose |
|---|---|---|
| `/` | HomePage | Hero, featured catalog, gift flow entry, hologram verify panel |
| `/shop` | ShopPage | Full catalog with sport and license filters |
| `/product/:sku/:slug` | ProductPage | Single product detail, gift form, related products |
| `/checkout` | CheckoutPage | Full checkout: name, email, attribution, Stripe redirect |
| `/checkout?session_id=...` | CheckoutPage (return) | Post-Stripe return: success or failure handling |
| `/consultant` | ConsultantLandingPage | Public-facing consultant recruitment landing page |
| `/*` | Redirect | All unmatched routes → `/` |

### Consultant Portal (`apps/consultant`, port 3002)

| URL | Page | Purpose |
|---|---|---|
| `/` | LoginPage | Supabase email/password sign-in |
| `/dashboard` | DashboardPage | Summary cards: sales, earnings, recent activity |
| `/earnings` | EarningsPage | Commission history table, status breakdown, date filter |
| `/orders` | OrdersPage | Order list attributed to this consultant |
| `/referrals` | ReferralToolsPage | Referral link display, copy button, share tools |
| `/profile` | ProfilePage | Edit display name, email, phone, mailing address |

### Admin Portal (`apps/admin`, port 3001)

| URL | Page | Purpose |
|---|---|---|
| `/` | LoginPage | Supabase email/password sign-in, admin role required |
| `/dashboard` | AdminDashboardPage | Inventory counts, recent orders, commission pipeline |
| `/orders` | OrdersPage | All orders list with status filters |
| `/orders/:orderId` | OrderDetailPage | Full order detail, ledger pipeline steps |
| `/inventory` | InventoryPage | Unit list, status filter, bulk upload trigger |
| `/inventory/:unitId` | UnitDetailPage | Full unit history, ledger entries, fraud flags, lock/unlock |
| `/consultants` | ConsultantsPage | Consultant list with status/tier filters |
| `/consultants/:consultantId` | ConsultantDetailPage | Profile, commission summary, status actions |
| `/payouts` | PayoutsPage | Approve payout batches, filter by consultant or date |

---

## 2. User Flows

### 2A. Customer Purchase Flow

| Step | Screen | Action | Result |
|---|---|---|---|
| 1 | HomePage | Lands on storefront | Hero and featured products load |
| 2 | HomePage | Sees a product | Clicks product card |
| 3 | ProductPage | Views product detail | Art, description, trust strip, gift form visible |
| 4 | ProductPage | Clicks "Gift This" | Scrolls to inline gift form |
| 5 | ProductPage | Enters recipient name and email | Form validates on blur |
| 6 | ProductPage | Clicks "Continue to Payment" | Navigate to `/checkout?sku=:sku` |
| 7 | CheckoutPage | Customer name and email pre-populated if available | Form ready |
| 8 | CheckoutPage | Fills name and email | Client-side validation on blur |
| 9 | CheckoutPage | Referral code visible if `?ref=` param present | Attribution confirmed |
| 10 | CheckoutPage | Clicks "Pay Now — $XX.XX" | `createOrder()` called → Edge Function |
| 11 | CheckoutPage | Loading spinner shown | Awaiting session_url |
| 12 | (Stripe) | Browser redirects to Stripe | Hosted checkout |
| 13 | (Stripe) | Customer enters card | Stripe handles payment |
| 14 | CheckoutPage | Stripe redirects to success_url | `?session_id=cs_...` in URL |
| 15 | CheckoutPage | `processOrderLedger()` called | Server-side fulfillment pipeline |
| 16 | CheckoutPage | Pipeline succeeds | Order confirmed, serial number displayed |
| 17 | CheckoutPage | Customer sees serial number and hologram stamp | Order complete |
| 18 | CheckoutPage | Clicks "Verify This Gift" | Scrolls or navigates to `/` with verify panel open |

### 2B. Referral Attribution Flow

| Step | Screen | Action | Result |
|---|---|---|---|
| 1 | (External) | Consultant shares `/?ref=GTG-CODE` | URL with referral param |
| 2 | HomePage | Customer lands on storefront | `?ref=GTG-CODE` detected on mount |
| 3 | HomePage | `resolveConsultantCode('GTG-CODE')` called | Returns `consultant_id` |
| 4 | HomePage | `consultant_id` stored in localStorage `gtg-ref-v1` | Attribution persisted |
| 5 | HomePage | Attribution banner shown briefly | Customer sees "Shopping with [Name]" |
| 6 | Any page | Customer browses normally | Attribution persists across navigation |
| 7 | CheckoutPage | `activeReferralCode` read from context | `consultantId` passed to `createOrder()` |
| 8 | (Edge Function) | `create-checkout-session` receives `consultant_id` | Commission entry flagged |
| 9 | (Edge Function) | `process-order-ledger` runs | Commission entry created `status: earned` |
| 10 | (Admin portal) | Admin reviews commissions | Approves → `status: approved` |
| 11 | (Admin portal) | Admin runs payout batch | `status: paid` |

### 2C. Consultant Portal Flow

| Step | Screen | Action | Result |
|---|---|---|---|
| 1 | LoginPage | Enters email and password | `supabase.auth.signInWithPassword()` |
| 2 | LoginPage | Valid credentials | Session established, redirect → `/dashboard` |
| 3 | DashboardPage | `getConsultantDashboard()` called | Profile, order summary, commission summary loaded |
| 4 | DashboardPage | Sees total sales, pending commission, recent orders | Overview at a glance |
| 5 | DashboardPage | Clicks "My Earnings" | Navigate to `/earnings` |
| 6 | EarningsPage | `getCommissionSummary()` called | Status breakdown, recent entries |
| 7 | EarningsPage | Applies date filter | Re-fetches with `fromDate/toDate` |
| 8 | DashboardPage | Clicks "Referral Tools" | Navigate to `/referrals` |
| 9 | ReferralToolsPage | `getReferralLink()` called | Referral URL, share text, lifetime stats |
| 10 | ReferralToolsPage | Copies link | `navigator.clipboard.writeText()`, "Copied!" confirmation |
| 11 | ProfilePage | Updates display name | `updateConsultantProfile({ displayName })` |
| 12 | ProfilePage | Success → updated value shown | No reload required |
| 13 | Any page | Session expires | `isAuthError()` → redirect to `/` |
| 14 | LoginPage | Clicks "Sign out" | `supabase.auth.signOut()`, redirect to `/` |
| 15 | LoginPage | Wrong password | `toUserMessage(error)` shown inline |

---

## 3. Screen Specifications

### 3A. Storefront: HomePage (`/`)

**Purpose:** Primary customer entry point. Presents brand, featured products, gift entry, hologram verification.

**Data required:**
- `listProducts()` → `ProductListItem[]` (featured subset, e.g. `limit: 6`)

**API functions:**
- `listProducts({ limit: 6 })` on mount
- `resolveConsultantCode(code)` if `?ref=` present in URL
- `verifyHologramSerial(serialNumber)` when verify form submitted

**UI elements:**
- Hero section: headline, subhead, primary CTA "Shop All Gifts"
- Featured products grid: 3–6 product cards
- Gift flow entry panel: pre-selects first featured product
- Hologram verify panel: serial number input, verify button, result display
- Site navigation (dark mode): logo, Shop, Verify, Consultants, cart icon with count

**Primary CTA:** "Shop All Gifts" → `/shop`

**Secondary actions:** Individual product cards → `/product/:sku/:slug`

**States:**
- Loading: skeleton shimmer for product cards
- Referral active: attribution banner "Shopping with [display_name]"
- Referral invalid: silent (no banner, code discarded)
- Verify success: product name, serial, hologram stamp displayed in green
- Verify failure: "Serial number not found" in red

**Navigation:** `SiteNav mode="dark"` overlaid on hero

---

### 3B. Storefront: ShopPage (`/shop`)

**Purpose:** Full browsable catalog with sport and license filtering.

**Data required:**
- `listProducts({ school?, license_body? })` → `ProductListItem[]`

**API functions:**
- `listProducts()` on mount and on filter change (debounced)

**UI elements:**
- Page header: "Shop All Gifts", sport tab bar (7 tabs), license tab bar (CLC / ARMY / All)
- Active filter spotlight panel: "Now browsing: [Sport] — [License]"
- Product grid: 8-up layout, each card links to `/product/:sku/:slug`
- "No results" empty state with reset filters button

**Primary CTA:** Individual product card "View Gift" → ProductPage

**States:**
- Loading: 8 shimmer skeleton cards
- Empty: `<EmptyState>` with "Reset Filters" button
- Sport filter: tab active state
- License filter: tab active state

**URL params:** `?sport=football&license=CLC` → pre-set filters on mount

---

### 3C. Storefront: ProductPage (`/product/:sku/:slug`)

**Purpose:** Single product detail. Full art display, description, trust signals, gift form.

**Data required:**
- Product record matched by `sku` from `useParams()`
- Related products: same sport, different SKU, max 4

**API functions:**
- None (product data from `StorefrontContext` product list)
- `addProductToCart()` from context when gift form submitted

**UI elements:**
- Breadcrumb: Home → Shop → [Product Name]
- Art frame: large product image
- Product name, sport badge, license badge
- Retail price (formatted via `formatUsdCents()`)
- Description paragraphs
- Trust strip: hologram icon, license icon, COA icon
- COA block: certificate of authenticity detail
- Inline gift form: recipient name, recipient email, "Continue to Payment" CTA
- Related products grid (compact cards)

**Primary CTA:** "Continue to Payment" → `/checkout?sku=:sku`

**States:**
- Product not found: "We couldn't find this product" with "Back to Shop" button
- Gift form success: green `<AlertBanner>` "Ready! Continuing to checkout…"
- Related products empty: section hidden

---

### 3D. Storefront: CheckoutPage (`/checkout`)

**Purpose:** Capture customer details, display attribution, redirect to Stripe, handle return.

**Data required:**
- Product from `?sku=` query param → looked up against product list
- Referral attribution from `StorefrontContext`

**API functions:**
- `createOrder(input)` → `CreateCheckoutSessionResult` (redirects to `session_url`)
- `processOrderLedger({ orderId })` → `SubmitOrderResult` (on Stripe return)

**UI elements:**
- Product summary: art thumbnail, name, price
- Consultant attribution row (if active): "Referred by [name]"
- Customer name field (required)
- Customer email field (required)
- "Pay Now — $XX.XX" button (disabled while loading)
- Loading spinner during `createOrder()` and `processOrderLedger()`
- Success state: order number, serial number, hologram image, "Verify This Gift" link
- Error state: `<AlertBanner variant="error">` with `toUserMessage(error)`

**Primary CTA:** "Pay Now — $XX.XX" → Stripe hosted checkout

**States:**
- Ready: form filled, button enabled
- Submitting: button disabled, spinner, "Processing…"
- Stripe redirect: browser leaves page
- Return — processing: spinner, "Finalizing your order…"
- Return — success: confirmation state with serial
- Return — failure: error banner, "Try Again" button
- Product not found: error state, link back to shop

---

### 3E. Storefront: ConsultantLandingPage (`/consultant`)

**Purpose:** Public recruitment page. No auth required.

**UI elements:**
- Hero: headline, subhead, "Apply to Join" CTA
- How It Works: 3-step process diagram
- Earnings table: tier breakdown (standard / senior / elite)
- Referral code demo: animated referral URL display
- Join form: name, email, phone (optional), submit button
- FAQ accordion: 4 questions
- Footer

**Primary CTA:** "Apply to Join" → scrolls to join form

**States:**
- Join form submitted: success banner "We'll be in touch!"
- (Backend not yet wired — form submit is placeholder)

---

### 3F. Consultant Portal: LoginPage (`/`)

**Purpose:** Supabase auth sign-in gate for all consultant portal pages.

**API functions:**
- `supabase.auth.signInWithPassword({ email, password })`

**UI elements:**
- Logo
- Email field
- Password field
- "Sign In" button
- Error message below form

**Primary CTA:** "Sign In"

**States:**
- Empty: form blank, button enabled
- Submitting: button disabled
- Error: inline message via `toUserMessage(error)`
- Success: redirect to `/dashboard`

---

### 3G. Consultant Portal: DashboardPage (`/dashboard`)

**Purpose:** Overview of consultant activity.

**API functions:**
- `getConsultantDashboard({ consultantId })` → `GetConsultantDashboardResult`

**UI elements:**
- Summary cards: Total Sales, Pending Commission, Total Orders, Lifetime Commissions
- Recent Orders table: order number, date, product, amount
- Recent Commissions table: entry, status badge, amount
- Quick links: Earnings, Referral Tools, Profile

**Primary CTA:** "View All Earnings" → `/earnings`

**States:**
- Loading: skeleton cards
- Empty (no orders): "No sales yet" empty state
- Error: `<AlertBanner variant="error">`

---

### 3H. Consultant Portal: EarningsPage (`/earnings`)

**Purpose:** Detailed commission history with status breakdown.

**API functions:**
- `getCommissionSummary({ consultantId, fromDate?, toDate? })`
- `getConsultantPendingPayouts({ consultantId })`

**UI elements:**
- Date range filter (from / to date inputs)
- Status breakdown cards: earned, held, approved, paid, reversed, voided
- Commission entries table: serial, product, rate, amount, status badge
- Pending payouts panel: total pending amount

**Primary CTA:** None (read-only view)

**States:**
- Loading: skeleton
- Date filter applied: re-fetches with date range
- Empty: "No commissions in this period"

---

### 3I. Consultant Portal: ReferralToolsPage (`/referrals`)

**Purpose:** Referral link management and sharing.

**API functions:**
- `getReferralLink()` → `GetReferralLinkResult`

**UI elements:**
- Referral URL display (read-only input)
- "Copy Link" button → `navigator.clipboard.writeText()`
- Share text block
- Lifetime stats: total referred orders, lifetime gross sales

**Primary CTA:** "Copy Link"

**States:**
- Loading: skeleton
- Copied: button label changes to "Copied!" for 2s
- Error: `<AlertBanner variant="error">`

---

### 3J. Consultant Portal: ProfilePage (`/profile`)

**Purpose:** Edit mutable consultant profile fields.

**API functions:**
- `getConsultantProfile()` → `ConsultantProfileRow`
- `updateConsultantProfile({ displayName?, email?, phone?, address? })`

**UI elements:**
- Display name field
- Contact email field
- Phone field (optional)
- Mailing address fields (for 1099, optional)
- "Save Changes" button
- "Discard" button

**Primary CTA:** "Save Changes"

**States:**
- Loading: skeleton fields
- Unchanged: "Save Changes" disabled
- Submitting: button disabled
- Success: `<InlineMessage variant="success">` "Profile updated"
- Error: `<InlineMessage variant="error">` with `toUserMessage(error)`

---

### 3K. Admin Portal: AdminDashboardPage (`/dashboard`)

**Purpose:** Operational overview across inventory, orders, and commissions.

**API functions:**
- `getInventoryStatus()` → unit counts by status
- `listProducts({ limit: 10 })` → active product count
- `getConsultantDashboard()` (summary scope)

**UI elements:**
- Inventory status row: available / reserved / sold / fraud_locked counts
- Recent orders table
- Commission pipeline summary: earned / held / approved amounts

**Primary CTA:** "Manage Inventory" → `/inventory`

---

### 3L. Admin Portal: OrdersPage (`/orders`)

**Purpose:** All orders across all consultants.

**API functions:**
- Direct Supabase query via `fetchOrderById()` or table query (paginated)

**UI elements:**
- Status filter tabs: all / pending / paid / failed / refunded
- Orders table: order number, customer, product, amount, consultant, date, status
- Pagination controls

**Primary CTA:** Row click → `/orders/:orderId`

---

### 3M. Admin Portal: OrderDetailPage (`/orders/:orderId`)

**Purpose:** Full order inspection including ledger pipeline steps.

**API functions:**
- `fetchOrderById({ orderId, includeLines: true })`

**UI elements:**
- Order header: number, status, total, customer, date
- Order lines table
- Ledger pipeline steps: each step with success/fail indicator
- Consultant attribution row (if present)

---

### 3N. Admin Portal: InventoryPage (`/inventory`)

**Purpose:** Browse all serialized units with status filtering.

**API functions:**
- `viewUnitStatus({ status?, limit, offset })`
- `getInventoryStatus()`

**UI elements:**
- Status filter tabs: all / available / reserved / sold / fraud_locked / returned / voided
- Units table: serial, SKU, product, status, batch, received date
- Bulk upload button → file input → `bulkUploadSerializedUnits()`
- Pagination controls

**Primary CTA:** Row click → `/inventory/:unitId`

---

### 3O. Admin Portal: UnitDetailPage (`/inventory/:unitId`)

**Purpose:** Full unit lifecycle: ledger entries, fraud flags, lock history.

**API functions:**
- `viewUnitHistory({ unit_id })`
- `getUnitStatus({ unit_id })`
- `lockUnit({ unitId, reason })` / `unlockUnit({ lockRecordId, releaseReason })`

**UI elements:**
- Unit header: serial, SKU, status badge
- Ledger entries timeline
- Fraud flags section
- Lock records section
- Lock / Unlock action buttons (admin only)
- Confirmation modal before lock/unlock

---

### 3P. Admin Portal: ConsultantsPage (`/consultants`)

**Purpose:** Manage consultant accounts.

**API functions:**
- `listConsultants({ status?, tier?, search?, limit, offset })`

**UI elements:**
- Search input
- Status filter: all / active / pending_approval / suspended / terminated
- Tier filter: standard / senior / elite / custom
- Consultants table: name, email, tier, status, total orders, lifetime commissions
- Pagination controls

**Primary CTA:** Row click → `/consultants/:consultantId`

---

### 3Q. Admin Portal: ConsultantDetailPage (`/consultants/:consultantId`)

**Purpose:** Individual consultant management.

**API functions:**
- `getConsultantProfile({ consultantId })`
- `getCommissionSummary({ consultantId })`
- `approveConsultant()` / `suspendConsultant()` / `terminateConsultant()` / `reactivateConsultant()`
- `assignConsultantCommissionRate()`

**UI elements:**
- Profile header: name, email, phone, tier badge, status badge
- Commission summary cards
- Recent entries table
- Status action button (context-aware: Approve / Suspend / Reactivate / Terminate)
- Tier assignment selector
- Confirmation modal for destructive actions

---

### 3R. Admin Portal: PayoutsPage (`/payouts`)

**Purpose:** Approve earned commission entries for payout.

**API functions:**
- `approvePayouts({ consultantId?, earnedBefore? })`
- `getConsultantPendingPayouts({ consultantId? })`

**UI elements:**
- Filter: consultant search, earned before date
- Pending payouts table: consultant, entries, total amount
- "Approve Selected" button
- "Approve All" button (with confirmation)
- Result summary after approval

**Primary CTA:** "Approve Payouts"

---

## 4. Checkout Architecture

### Single Authority

`/checkout` is the single checkout entry point for all purchase flows. No other page creates orders. Product pages and cart flows navigate to `/checkout?sku=:sku`.

### URL Parameters

| Param | Required | Description |
|---|---|---|
| `sku` | Yes | Product SKU — used to look up product from context |

### CheckoutPage Fields

| Field | Required | Validation |
|---|---|---|
| `customerName` | Yes | Non-empty string after trim |
| `customerEmail` | Yes | Non-empty, contains `@` |
| `consultantId` | No | UUID v4, resolved from `activeReferralCode` in context |
| `discountCode` | No | String, uppercased before send |

### 9-Step Checkout Flow

1. Customer navigates to `/checkout?sku=:sku`
2. Product looked up from `StorefrontContext` product list by SKU
3. Attribution: `activeReferralCode` from context resolves to `consultantId`
4. Customer fills name and email
5. Customer clicks "Pay Now" → `createOrder()` called
6. `create-checkout-session` Edge Function: reserves unit, creates pending order, returns `session_url`
7. Browser redirects to `session_url` (Stripe hosted checkout)
8. Customer completes payment on Stripe
9. Stripe redirects to `success_url` (`/checkout?session_id=cs_...`)
10. On return: `processOrderLedger({ orderId })` called → fulfillment pipeline
11. Success: order confirmed, serial number displayed

### Cancel Flow

If customer cancels on Stripe, they land on `cancel_url` (`/checkout?cancelled=1`).
`CheckoutPage` detects `?cancelled=1` → shows `<AlertBanner variant="warning">` "Payment cancelled. Your cart is still waiting."

### `createOrder` Input/Output

Input (`CreateCheckoutSessionInput`):
```
productId      string  UUID v4 — required
quantity       1       always exactly 1
customerName   string  required, trimmed server-side
customerEmail  string  required, lowercased server-side
successUrl     string  required
cancelUrl      string  required
consultantId   string? UUID v4, if attribution present
discountCode   string? uppercased
```

Output (`CreateCheckoutSessionResult`):
```
order_id       string  UUID — persist to sessionStorage before redirect
order_number   string  human-readable GTG-XXXXX
session_id     string  Stripe session ID cs_...
session_url    string  redirect target
unit_id        string  reserved unit UUID
serial_number  string  hologram serial
product_id     string
sku            string
product_name   string
channel        'storefront_direct' | 'consultant_assisted'
```

**Critical:** `order_id` must be persisted to `sessionStorage` before redirecting to `session_url`. On Stripe return, `order_id` is read from `sessionStorage` and passed to `processOrderLedger()`.

### `processOrderLedger` Input/Output

Input: `{ orderId: string }`

Output (`SubmitOrderResult`):
```
phase              string
pipeline           'processOrderLedger'
order_id           string
success            boolean
status             'completed' | 'failed'
failed_step        string?
completed_steps    number
total_steps        number
steps              SubmitOrderStep[]
errors             SubmitOrderStepError[]
```

If `status === 'failed'`: display `<AlertBanner variant="error">` with failed_step detail and `toUserMessage()`.

---

## 5. Component System

### Button

```ts
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  href?: string
  type?: 'button' | 'submit' | 'reset'
  onClick?: () => void
  children: ReactNode
}
```

Rules:
- `loading` → renders spinner + label; disables interaction
- `href` → renders as `<a>` tag, not `<button>`
- `variant="primary"` is gold background; `variant="danger"` is red; only for destructive admin actions
- Never use `ghost` for primary actions
- All confirm-required admin actions use `variant="danger"`

Anti-patterns:
- Do not use two `primary` buttons side by side
- Do not use `loading` without also setting `disabled`

---

### ProductCard

```ts
interface ProductCardProps {
  name: string
  sport: string
  licenseBody: LicenseBody
  retailPriceCents: number
  imageSrc?: string
  imageAlt?: string
  badges?: string[]
  details?: string[]
  priceTrailing?: string
  actionLabel?: string
  actionVariant?: 'primary' | 'secondary' | 'ghost'
  compact?: boolean
  href?: string
  disabled?: boolean
  ariaLabel?: string
  onAddToCart?: () => void
}
```

Rules:
- `compact` → reduced padding, smaller image, no details block; used for related products
- `href` → entire card is a link; `onAddToCart` → action button shown
- Sport badge always rendered; license badge always rendered
- `retailPriceCents` formatted via `formatUsdCents()` — never format inline

---

### Badge

```ts
interface BadgeProps {
  variant: 'sport' | 'license' | 'status' | 'success' | 'error' | 'warning' | 'neutral'
  children: ReactNode
}
```

Rules:
- `sport` → navy background; `license` → gold background
- `success` → green; `error` → red; `warning` → amber
- Never use `status` in storefront; it is for admin commission status only

---

### Heading

```ts
interface HeadingProps {
  level: 1 | 2 | 3 | 4 | 5 | 6
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  muted?: boolean
  children: ReactNode
}
```

Rules:
- `level 1–3` → Playfair Display (display font)
- `level 4–6` → Inter (body font)
- `italic` only valid on display levels (1–3)
- `muted` → `color: var(--color-text-secondary)`

---

### AlertBanner

```ts
interface AlertBannerProps {
  variant: 'info' | 'success' | 'warning' | 'error'
  dismissible?: boolean
  children: ReactNode
}
```

Rules:
- Always shown inline, not as toast/modal
- `error` variant must include recovery action (button or link)
- `dismissible` only for non-critical info banners

---

### SiteNav

```ts
interface SiteNavProps {
  mode?: 'dark' | 'light'
}
```

Rules:
- `mode="dark"` → overlaid on hero, white text
- `mode="light"` → standard navbar, dark text
- Cart count badge reads from `useStorefront()` — never passed as prop
- Never render `SiteNav` inside a page component other than at the very top

---

### InlineMessage

```ts
interface InlineMessageProps {
  variant: 'info' | 'success' | 'error'
  children: ReactNode
}
```

Rules:
- Use for field-level validation feedback
- Use for form-level success confirmation that does not require a full banner
- `AlertBanner` for page-level; `InlineMessage` for form-level

---

### SectionIntro

```ts
interface SectionIntroProps {
  title: string
  subtitle?: string
  align?: 'left' | 'center'
}
```

Rules:
- Default `align="center"` for marketing sections
- `align="left"` for content sections (product detail panels, portal sections)

---

## 6. Design System Rules

### Typography

| Level | Tag | Font | Weight | Size | Use |
|---|---|---|---|---|---|
| Display XL | h1 | Playfair Display | 700 | 3.5rem | Hero headline |
| Display L | h2 | Playfair Display | 700 | 2.5rem | Section headline |
| Display M | h3 | Playfair Display | 600 | 2rem | Card headline |
| Body XL | h4 | Inter | 600 | 1.25rem | Subsection label |
| Body L | h5 | Inter | 600 | 1.125rem | Panel label |
| Body M | p | Inter | 400 | 1rem | Body text |
| Body S | small | Inter | 400 | 0.875rem | Captions, metadata |
| Label | label | Inter | 500 | 0.875rem | Form labels |

Rules:
- Never mix Playfair Display below h3
- Never set font directly — always use semantic heading levels or CSS utility classes
- `line-height: 1.2` for display; `line-height: 1.6` for body

---

### Spacing

Base unit: 4px (`--space-1 = 4px`)

| Token | Value | Use |
|---|---|---|
| `--space-1` | 4px | Icon gap, inline padding |
| `--space-2` | 8px | Input inner padding, badge padding |
| `--space-3` | 12px | Small gap between elements |
| `--space-4` | 16px | Standard gap, card padding |
| `--space-6` | 24px | Section inner padding |
| `--space-8` | 32px | Large gap, section bottom margin |
| `--space-12` | 48px | Section top margin |
| `--space-16` | 64px | Page section spacing |
| `--space-24` | 96px | Hero vertical padding |

Rules:
- All spacing in CSS uses `var(--space-N)` tokens — never hardcoded pixel values
- Component internal spacing uses `--space-2` / `--space-4`
- Section gaps use `--space-8` / `--space-12`

---

### Color Policy

| Token | Use | Never use for |
|---|---|---|
| `--color-primary-600` | Primary button background | Text on dark backgrounds |
| `--color-accent-500` | Gold accent, license badge | Body text |
| `--color-interactive` | Links, focus rings | Decorative color |
| `--color-text-primary` | All body text | Headings on dark backgrounds |
| `--color-text-secondary` | Captions, metadata, muted text | Primary body copy |
| `--color-surface` | Page background, card background | Text |
| `--color-border` | All borders and dividers | Background |
| `--color-success` | Success badges, confirm banners | General green styling |
| `--color-error` | Error messages, danger buttons | Warning messages |

---

### Button Styling Rules

- `primary`: `background: var(--color-interactive)`, white text, no outline
- `secondary`: `border: 1px solid var(--color-border)`, transparent background
- `ghost`: no border, no background, `color: var(--color-interactive)` on hover
- `danger`: `background: var(--color-error)`, white text — admin destructive only
- Minimum click target: 44×44px (WCAG AA)
- Focus: `outline: var(--focus-ring)` on `:focus-visible`

---

## 7. State System

### Loading States

| Screen | Loading trigger | Loading treatment |
|---|---|---|
| ShopPage | `listProducts()` in flight | 8 shimmer skeleton cards |
| ProductPage | Product not in context yet | Full-page skeleton |
| CheckoutPage `createOrder()` | Button clicked | Button disabled + spinner |
| CheckoutPage `processOrderLedger()` | Stripe return | Full overlay spinner "Finalizing…" |
| DashboardPage | `getConsultantDashboard()` | Skeleton summary cards |
| EarningsPage | `getCommissionSummary()` | Table skeleton |
| ReferralToolsPage | `getReferralLink()` | Skeleton |
| AdminDashboardPage | `getInventoryStatus()` | Skeleton cards |
| ConsultantsPage | `listConsultants()` | Table skeleton |

### Empty States

| Screen | Empty condition | Treatment |
|---|---|---|
| ShopPage | No products match filters | `<EmptyState>` + "Reset Filters" button |
| DashboardPage | No orders | `<EmptyState>` "No sales yet — share your referral link!" |
| EarningsPage | No commissions in period | `<EmptyState>` "No commissions in this date range" |
| OrdersPage (admin) | No orders | `<EmptyState>` "No orders found" |
| ConsultantsPage | No consultants match | `<EmptyState>` "No consultants match your search" |

### Error States

| Error code | User message | Recovery |
|---|---|---|
| `VALIDATION_ERROR` | Stripped domain message | Fix the form field |
| `BUSINESS_ERROR` | Stripped domain message | Depends on domain rule |
| `FUNCTION_ERROR` (no status) | "Unable to reach the server. Check your connection and try again." | Retry button |
| `FUNCTION_ERROR` (5xx) | "A server error occurred. Please try again in a moment." | Retry button |
| `FUNCTION_ERROR` (401) | "Your session has expired. Please reload the page and sign in again." | Reload link |
| `FUNCTION_ERROR` (403) | "You do not have permission to perform this action." | Contact admin |
| `FUNCTION_ERROR` (429) | "Too many requests. Please wait a moment and try again." | Wait, then retry |
| `QUERY_ERROR` | "Something went wrong. Please try again." | Retry button |
| `EMPTY_RESPONSE` | "Something went wrong. Please try again." | Retry button |

All error messages rendered via `toUserMessage(error)`. Never render `error.message` raw in the UI.

---

## 8. UI ↔ API Data Contracts

### ProductListItem (from `listProducts()`)

| Field | Type | Display rule |
|---|---|---|
| `id` | string | Pass to `createOrder()` as `productId` |
| `sku` | string | Use in URL: `/product/:sku/:slug` |
| `name` | string | Product card title |
| `description` | string? | Body text on ProductPage |
| `school` | string? | Shown in description block |
| `license_body` | `LicenseBody` | `<Badge variant="license">` |
| `retail_price_cents` | number | `formatUsdCents(retail_price_cents)` — never format raw |
| `available_count` | number | If `0`, show "Out of Stock" badge, disable cart action |
| `in_stock` | boolean | Primary availability gate |
| `created_at` | string | ISO 8601 — not displayed in storefront |

---

### `createOrder` / `createCheckoutSession`

Minimum call site:
```ts
const result = await createOrder({
  productId: product.id,       // UUID from ProductListItem.id
  customerName,                // trimmed
  customerEmail,               // trimmed, lowercase
  successUrl: `${origin}/checkout?session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${origin}/checkout?cancelled=1`,
  consultantId,                // optional UUID from referral attribution
})
// Before redirect:
sessionStorage.setItem('gtg-checkout-v1', JSON.stringify({
  orderId: result.order_id,
  orderNumber: result.order_number,
  serialNumber: result.serial_number,
  productName: result.product_name,
}))
window.location.href = result.session_url
```

---

### `GetConsultantDashboardResult`

| Field | Display rule |
|---|---|
| `profile.display_name` | Page heading "Welcome, [name]" |
| `profile.commission_tier` | Badge in sidebar |
| `orderSummary.totalOrders` | Summary card |
| `orderSummary.totalSalesCents` | `formatUsdCents()`, summary card |
| `commissionSummary.totalCommissionCents` | `formatUsdCents()`, summary card |
| `commissionSummary.byStatus.earned.commissionCents` | "Pending payout" card |
| `recentOrders` | Table, max 10 rows |
| `recentCommissions` | Table, max 10 rows |

---

## 9. CTA Language

### Storefront

| Context | CTA Label | Action |
|---|---|---|
| Hero | "Shop All Gifts" | Navigate to `/shop` |
| Product card | "View Gift" | Navigate to `/product/:sku/:slug` |
| Product card (compact) | "View" | Navigate to `/product/:sku/:slug` |
| Product detail | "Gift This" | Scroll to inline gift form |
| Gift form | "Continue to Payment" | Navigate to `/checkout?sku=:sku` |
| Checkout | "Pay Now — $XX.XX" | Submit `createOrder()` |
| Checkout (loading) | "Processing…" | Disabled state |
| Hologram verify | "Verify Serial" | Submit `verifyHologramSerial()` |
| Order confirmation | "Verify This Gift" | Navigate to `/?verify=true` |
| Referral attribution | "Dismiss" | Remove attribution banner |
| Empty state (shop) | "Reset Filters" | Clear all filter state |
| Product not found | "Back to Shop" | Navigate to `/shop` |
| Checkout cancelled | "Try Again" | Reset checkout form |

### Consultant Portal

| Context | CTA Label | Action |
|---|---|---|
| Login | "Sign In" | `supabase.auth.signInWithPassword()` |
| Referral Tools | "Copy Link" | `navigator.clipboard.writeText()` |
| Profile | "Save Changes" | `updateConsultantProfile()` |
| Profile | "Discard" | Reset form fields |

### Admin Portal

| Context | CTA Label | Confirm required | Action |
|---|---|---|---|
| Consultant list | "View" | No | Navigate to detail |
| Consultant detail | "Approve" | Yes | `approveConsultant()` |
| Consultant detail | "Suspend" | Yes — requires reason | `suspendConsultant()` |
| Consultant detail | "Terminate" | Yes — requires reason | `terminateConsultant()` |
| Consultant detail | "Reactivate" | Yes | `reactivateConsultant()` |
| Inventory — unit | "Lock Unit" | Yes — requires reason | `lockUnit()` |
| Inventory — unit | "Unlock Unit" | Yes — requires release reason | `unlockUnit()` |
| Payouts | "Approve Payouts" | Yes | `approvePayouts()` |

---

## 10. Interaction Rules

### Navigation

- All internal storefront links use `<Link>` from `react-router-dom` — never `<a href>` for internal routes
- Product cards use `href` prop on `<ProductCard>` → renders as `<a>` (accessible, cmd+click opens in new tab)
- Consultant portal and admin portal use `<Link>` for all internal nav
- External links (Stripe, license body pages) use `<a target="_blank" rel="noopener noreferrer">`

### Click Behavior

| Element | Click behavior |
|---|---|
| ProductCard | Navigate to `/product/:sku/:slug` |
| "Pay Now" button | Submit form → `createOrder()` → redirect |
| "Copy Link" button | Clipboard write → temporary "Copied!" label |
| Admin status action | Open confirmation modal → action on confirm |
| Admin lock/unlock | Open confirmation modal with reason field → action on confirm |
| Dismiss banner | Remove from DOM, clear from context state |
| Filter tab | Immediate filter apply, no submit required |

### Validation Behavior

| Trigger | Behavior |
|---|---|
| On blur | Field-level validation message shown below field |
| On submit | All fields validated; first error focused |
| API error | `toUserMessage(error)` in `<AlertBanner variant="error">` above form |
| API success | Form state cleared, success banner shown |

Field-level messages: `<InlineMessage variant="error">` directly below the input.
Form-level messages: `<AlertBanner>` above the submit button.
Recovery: always include an action — retry, fix field, or contact admin.

### Loading Patterns

- Button `loading` prop: spinner + "Processing…" label, button disabled
- Page skeleton: full-width shimmer rows/cards matching expected layout
- Overlay spinner: used only for Stripe return processing (full-page block)
- Never show "loading…" text without a visual spinner or skeleton
- Loading state must be cleared on both success and error

---

## 11. Edge Cases

### Payment Failure

| Scenario | Detection | UI treatment | Recovery |
|---|---|---|---|
| Customer cancels on Stripe | `?cancelled=1` in return URL | Warning banner "Payment cancelled. Your cart is still waiting." | "Try Again" button re-submits form |
| `createOrder()` fails (network) | `FUNCTION_ERROR`, no statusCode | Error banner + "Try Again" | Retry `createOrder()` |
| `createOrder()` fails (out of stock) | `BUSINESS_ERROR` | Error banner "This product is no longer available." | Link back to shop |
| `processOrderLedger()` fails | `status: failed` in result | Error banner with `failed_step` detail | "Contact support" link |
| `processOrderLedger()` times out | `FUNCTION_ERROR` 5xx | Error banner "Server error finalizing order." | "Try again" — re-calls with same `order_id` |

### Out of Stock

| Location | Detection | Treatment |
|---|---|---|
| ShopPage product card | `in_stock: false` or `available_count: 0` | "Out of Stock" badge overlaid; card link disabled |
| ProductPage | Same | Gift form hidden; "Currently unavailable" message |
| CheckoutPage | `BUSINESS_ERROR` from `createOrder()` | Error banner; return to shop link |
| Admin InventoryPage | `available: 0` count in status | Warning indicator in dashboard |

### API Failures

| Scenario | Error code | User message | Recovery action |
|---|---|---|---|
| Network offline | `FUNCTION_ERROR`, no statusCode | "Unable to reach the server. Check your connection and try again." | Retry button |
| Edge function 500 | `FUNCTION_ERROR`, 5xx | "A server error occurred. Please try again in a moment." | Retry button |
| Rate limited | `FUNCTION_ERROR`, 429 | "Too many requests. Please wait a moment and try again." | Auto-retry after 5s, or manual retry |
| Session expired | `FUNCTION_ERROR`, 401 | "Your session has expired. Please reload the page and sign in again." | Reload link |
| Permission denied | `FUNCTION_ERROR`, 403 | "You do not have permission to perform this action." | Contact admin message |
| Business rule violation | `BUSINESS_ERROR` | Stripped domain message from `toUserMessage()` | Depends on rule — fix form or contact support |
| Validation rejected | `VALIDATION_ERROR` | Stripped domain message | Fix the form field |
| Empty response | `EMPTY_RESPONSE` | "Something went wrong. Please try again." | Retry |

All API errors are caught as `ApiRequestError`. Use `isTransientError(err)` to determine if automatic retry is safe. Never auto-retry `VALIDATION_ERROR` or `BUSINESS_ERROR`.

---

*This specification is the single source of truth for all Game Time Gift UI implementation. Any implementation that conflicts with this document is incorrect. Update this document when the API contracts, routes, or business rules change.*
