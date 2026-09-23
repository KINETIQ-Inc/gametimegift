# Controlled Production Release Runbook

Game Time Gift has one production release path: the GitHub Actions workflow
`Release Production`. A green CI run or a successful Vercel build is not, by
itself, a production release.

## Why this exists

The storefront, Supabase schema, Supabase Edge Functions, static product assets,
and Vercel deployment form one runtime contract. Deploying only one part can
produce a green build and a broken site. The release workflow therefore performs
these operations in order:

1. Re-run the complete repository quality gate.
2. Link the intended Supabase production project.
3. Display and dry-run the migration plan.
4. Apply committed migrations.
5. Deploy committed Edge Functions.
6. Build a Vercel production candidate without assigning the live domains.
7. Smoke-test that exact candidate, the catalog endpoint, and every committed
   product PNG.
8. Promote the verified candidate to the production domains.
9. Repeat the smoke test against the canonical production URL.

The workflow uses a production concurrency lock and never cancels an in-progress
release.

## Required GitHub production environment

Create a GitHub Actions environment named `production`. Configure required
reviewers and prevent self-review if the repository plan supports those controls.

Environment secrets:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_ANON_KEY`
- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Environment variables:

- `SUPABASE_PROJECT_REF`
- `SUPABASE_URL`
- `PRODUCTION_SITE_URL` (canonical value: `https://www.gametimegift.com`)

Do not place service-role, Stripe secret, webhook, or JWT-secret values in
frontend variables. Runtime secrets remain managed in the Supabase and Vercel
project settings.

## Vercel Git integration

`vercel.json` disables automatic Git deployments for `main` and `master`.
Preview deployments for feature branches remain available. Production is
assigned only after the controlled workflow successfully smoke-tests the exact
candidate deployment.

Confirm the Vercel project uses `apps/storefront` as its Root Directory and that
its production environment variables are complete before enabling releases.

## Brownfield database prerequisite

Do **not** run the production workflow against the current legacy production
database until the legacy-to-canonical bridge migration has been rehearsed and
approved. The committed migration history begins with greenfield table creation,
while the existing project already contains older tables with incompatible
columns. The workflow's migration dry-run is intended to stop this mismatch.

Before the first controlled release:

1. Capture a complete production backup.
2. Restore it into an isolated rehearsal database.
3. Inventory production schema, constraints, policies, functions, migration
   history, row counts, and money/licensing values.
4. Implement and rehearse an additive legacy-to-canonical bridge migration.
5. Verify IDs, SKUs, money, licenses, orders, inventory, and authentication.
6. Rehearse the full workflow against staging.
7. Approve a maintenance window and rollback point.

Never use `supabase migration repair` merely to make migration lists appear
equal. A migration may be marked applied only after its complete schema contract
has been independently verified on the target database.

## Migration policy

- Every production schema change must be a committed forward migration.
- Migrations must be backward-compatible with the currently promoted frontend
  until the new candidate passes smoke testing.
- Destructive column/table removal is a later contract migration, never part of
  the same release that introduces the replacement.
- Money conversions and licensing mappings require reconciliation queries and
  recorded expected totals.
- A migration and its dependent Edge Function/frontend change ship through the
  same production workflow.

## Running a release

1. Confirm the target commit is on `main` and CI is green.
2. Open **Actions → Release Production → Run workflow**.
3. Select `main` and enter `RELEASE` in the confirmation field.
4. Approve the protected `production` environment when prompted.
5. Review the migration list and each deployment step.
6. Do not separately redeploy Vercel or Supabase during the workflow.

If any pre-promotion step fails, the candidate is not assigned to the live
domains. If the final canonical-domain smoke test fails, treat the release as an
incident and use the Vercel dashboard to roll the domain back to the previously
verified deployment while assessing whether the database change needs its
prepared forward recovery migration.

## Definition of done

A release is complete only when the final workflow step verifies:

- the canonical domain serves the exact expected commit;
- the storefront returns HTML;
- `list-products` returns a valid product array;
- every committed product PNG returns a valid PNG response;
- all earlier CI, migration, Edge Function, candidate, and promotion steps
  succeeded.
