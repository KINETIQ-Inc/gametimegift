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
