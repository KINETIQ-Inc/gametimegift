/**
 * Seasonal campaign domain — RESERVED, NOT IMPLEMENTED.
 *
 * See docs/adr/0004-campaign-domain-reserved.md for the full rationale.
 *
 * Type-only placeholders so a future implementation has a named landing spot.
 * Nothing here is wired into @gtg/api yet — there is no backing `campaigns`
 * table to validate against. Do not import this module expecting runtime
 * behavior.
 *
 * This extends the existing (schema-less) `Campaign` concept already
 * documented in `packages/api/src/campaign.ts` — it is not a second,
 * competing campaign concept.
 */

/** A seasonal merchandising campaign (Mother's Day, Graduation, etc.). */
export interface SeasonalCampaign {
  id: string
  name: string
  theme: string
}

/** Join: which SKUs are featured in / exclusive to a campaign. */
export interface CampaignProductLink {
  campaignId: string
  productId: string
}

/** Join: which consultants are assigned to / participating in a campaign. */
export interface CampaignConsultantLink {
  campaignId: string
  consultantId: string
}
