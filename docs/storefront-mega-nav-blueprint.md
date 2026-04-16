# Storefront Mega Nav Blueprint (Phase 1)

Goal: deliver the same shopping-discovery outcome as the reference pattern, but with a distinct GTG interaction model and visual language.

## Product Goals

- Help users find products quickly by league/license context.
- Surface high-intent links (teams, player-themed collections, merch types).
- Keep search and seasonal CTA always available at header level.
- Preserve current GTG funnels: `#catalog`, `#verify`, Father's Day campaign route.

## Distinct GTG Pattern (Not a Clone)

GTG direction:

- Primary tabs are pill-style league chips with subtle motion and badge accents.
- Mega panel uses a split layout:
  - Left: team index columns.
  - Center: "Popular in this League" content cards.
  - Right: "Shop by Gift Type" quick links + campaign tile.
- Header actions remain independent of panel:
  - Campaign CTA (`SHOP FATHER'S DAY GIFTS`).
  - Search CTA.

## Information Architecture

Top-level tabs:

- `FEATURED`
- `NFL`
- `NCAA`
- `MLB`
- `NBA` (coming soon)
- `NHL` (coming soon)
- `SOCCER` (coming soon)
- `MILITARY`
- `COLLECTIBLES`

Within each tab, panel sections:

1. Teams (0-3 columns depending on tab)
2. Popular Picks (players, programs, themes)
3. Gift Types (jerseys, footballs, helmets, bundles, etc.)
4. Seasonal block (campaign route and spotlight)

## Interaction Rules

Desktop:

- Hover on tab opens panel with 100-140ms delay.
- Click on tab locks panel open.
- Moving pointer into panel keeps it open.
- `Esc`, outside click, or blur closes panel.
- Last active tab state is remembered for the session.

Mobile/Tablet:

- Tabs render in horizontal scroll row.
- Tap opens a bottom sheet/drawer variant.
- Drawer uses accordion sections (Teams, Popular, Gift Types).
- Search CTA remains visible at top-right.

## Accessibility Contract

- Tabs use `role="tablist"` and `role="tab"` with `aria-selected`.
- Mega panel has `aria-labelledby` to active tab.
- Keyboard support:
  - Left/Right arrows navigate tabs.
  - Enter/Space opens locked state.
  - Esc closes.
  - Focus trap only when panel is locked open.

## Visual Direction

- Keep GTG navy/gold system; avoid generic gray enterprise menu styling.
- Use rounded cards, light separators, and branded hover backgrounds.
- Add subtle slide/fade animation for panel entrance.
- Introduce icon badges per league (textual fallback for accessibility).

## Non-Goals (Phase 1/2)

- No backend schema changes.
- No dynamic CMS ingestion yet.
- No personalized ranking.

## Implementation Notes for Phase 3

- Drive menu from typed config only (no hard-coded JSX lists).
- Reuse existing routes/anchors where possible.
- Build as composable components:
  - `MegaNavBar`
  - `MegaNavPanel`
  - `LeagueTeamsColumn`
  - `PopularPicksPanel`
  - `GiftTypesPanel`

