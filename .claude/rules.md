# Engineering Rules

## Supabase

* Never recreate or reinitialize the Supabase client
* Always use the existing client from: @gtg/supabase
* Do not duplicate configuration logic

## Data Fetching

* Never hardcode product or database data
* All data must be fetched from Supabase
* Use hooks for data access (e.g., useProducts)

## Architecture

* Separate concerns:

  * Hooks = data fetching
  * Components = UI rendering
* No business logic inside UI components

## State Handling

* Every data fetch must include:

  * loading state
  * error handling
  * empty state handling

## Security

* Never expose secret keys
* Only use public environment variables (VITE_*)
* No sensitive logic in frontend

## Code Quality

* Avoid duplication
* Keep components reusable
* Follow existing project structure

## Frontend Data Rule (CRITICAL)

* Frontend is READ-ONLY
* Frontend may fetch and display data from Supabase
* Frontend must NEVER:

  * calculate prices (no math on cents, totals, discounts, taxes, or fees)
  * enforce inventory (no stock gating beyond UI display)
  * make business decisions (no eligibility, licensing, fulfillment, or commission logic)

* All business logic must live in:

  * Edge Functions
  * API layer (`@gtg/api`)

* Any violation of this rule is CRITICAL severity in audits

* Acceptable frontend patterns:

  * Displaying `product.retail_price_cents` from API response — OK
  * Displaying `product.in_stock` to hide/show a button — OK (UI only)
  * Passing user input (codes, quantities) to API calls — OK
  * Using `serverOrderTotalCents` from `createOrder()` result — OK

* Prohibited frontend patterns:

  * Computing subtotals, taxes, or discounts locally
  * Blocking checkout based on locally-evaluated inventory
  * Applying discount percentages or royalty rates in component code
