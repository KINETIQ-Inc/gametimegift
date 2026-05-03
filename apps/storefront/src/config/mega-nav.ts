export type NavAudience = 'all' | 'collectors' | 'military'

export type NavTabId =
  | 'featured'
  | 'nfl'
  | 'ncaa'
  | 'mlb'
  | 'nba'
  | 'nhl'
  | 'soccer'
  | 'military'
  | 'collectibles'

export type LeagueStatus = 'live' | 'coming_soon'

export interface TeamLink {
  label: string
  href: string
}

export interface ConferenceGroup {
  label: string
  teams: TeamLink[]
}

export interface PopularPick {
  label: string
  href: string
  tag?: string
}

export interface GiftTypeLink {
  label: string
  href: string
}

export interface SeasonalSpotlight {
  title: string
  subtitle: string
  href: string
}

export interface ConferenceSchoolMatcher {
  label: string
  aliases?: string[]
}

export interface MegaNavTab {
  id: NavTabId
  label: string
  status: LeagueStatus
  audience: NavAudience
  // Maps tab into current GTG product license model for filtering.
  productFilters: {
    license_body?: 'CLC' | 'ARMY' | 'NONE'
    featured?: boolean
  }
  teams: TeamLink[]
  conferences?: ConferenceGroup[]
  popularPicks: PopularPick[]
  giftTypes: GiftTypeLink[]
  seasonal: SeasonalSpotlight
}

function buildShopHref(params: Record<string, string>): string {
  const search = new URLSearchParams(params)
  return `/shop?${search.toString()}`
}

export const NCAA_CONFERENCE_GROUPS: readonly {
  label: string
  teams: readonly ConferenceSchoolMatcher[]
}[] = [
  {
    label: 'SEC',
    teams: [
      { label: 'The University of Alabama', aliases: ['University of Alabama', 'Alabama'] },
      { label: 'Louisiana State University', aliases: ['LSU'] },
      { label: 'University of Florida', aliases: ['Florida', 'Florida Gators'] },
      { label: 'University of Oklahoma', aliases: ['Oklahoma', 'OU'] },
      { label: 'University of South Carolina', aliases: ['South Carolina'] },
    ],
  },
  {
    label: 'Big Ten',
    teams: [
      { label: 'Michigan State University', aliases: ['Michigan State', 'MSU'] },
      { label: 'Pennsylvania State University', aliases: ['Penn State University', 'Penn State', 'PSU'] },
      { label: 'University of Maryland', aliases: ['Maryland', 'UMD'] },
    ],
  },
  {
    label: 'ACC',
    teams: [
      { label: 'Clemson University', aliases: ['Clemson'] },
      { label: 'Florida State University', aliases: ['Florida State', 'FSU'] },
      { label: 'University of Louisville', aliases: ['Louisville', 'UL'] },
    ],
  },
  {
    label: 'Big 12',
    teams: [
      { label: 'Arizona State University', aliases: ['Arizona State', 'ASU'] },
    ],
  },
  {
    label: 'SWAC',
    teams: [
      { label: 'Jackson State University', aliases: ['Jackson State', 'JSU'] },
      { label: 'Southern University', aliases: ['Southern'] },
    ],
  },
  {
    label: 'MEAC',
    teams: [
      { label: 'Coppin State' },
      { label: 'Howard University', aliases: ['Howard'] },
      { label: 'North Carolina A&T State University', aliases: ['North Carolina A&T', 'North Carolina A and T', 'NCAT'] },
    ],
  },
  {
    label: 'Independent / Other',
    teams: [
      { label: 'Eastern Michigan University', aliases: ['Eastern Michigan', 'EMU'] },
      { label: 'Tennessee State University', aliases: ['Tennessee State', 'TSU'] },
      { label: 'Texas A&M', aliases: ['Texas A&M University', 'Texas AM', 'TAMU'] },
      { label: 'United States Naval Academy', aliases: ['Navy', 'Naval Academy'] },
      { label: 'University of Mississippi', aliases: ['Ole Miss', 'Mississippi'] },
    ],
  },
] as const

// Phase 2 IA data source for the storefront mega nav.
// Phase 3 UI should render directly from this config.
export const MEGA_NAV_TABS: readonly MegaNavTab[] = [
  {
    id: 'featured',
    label: 'Featured',
    status: 'live',
    audience: 'all',
    productFilters: { featured: true },
    teams: [
      { label: 'Top Sellers', href: '#catalog' },
      { label: 'Father\'s Day Picks', href: '/fathers-day-2026' },
      { label: 'Verified Collectibles', href: '/authenticity' },
    ],
    popularPicks: [
      { label: 'NCAA Gifts', href: '#catalog?license=CLC', tag: 'NCAA' },
      { label: 'Military Gifts', href: '#catalog?license=ARMY', tag: 'ARMY' },
      { label: 'Game Time Gift Originals', href: '#catalog?license=NONE', tag: 'GTG' },
    ],
    giftTypes: [
      { label: 'Football Display Gifts', href: '#catalog' },
      { label: 'Helmet Gifts', href: '#catalog' },
      { label: 'Limited Bundles', href: '/fathers-day-2026' },
    ],
    seasonal: {
      title: 'Father\'s Day Launch',
      subtitle: 'Shop the Ultimate Gifts for Dad\'s Team',
      href: '/fathers-day-2026',
    },
  },
  {
    id: 'nfl',
    label: 'NFL',
    status: 'live',
    audience: 'all',
    productFilters: { license_body: 'NONE' },
    teams: [
      { label: 'Arizona Cardinals', href: '#catalog' },
      { label: 'Dallas Cowboys', href: '#catalog' },
      { label: 'Green Bay Packers', href: '#catalog' },
      { label: 'Kansas City Chiefs', href: '#catalog' },
      { label: 'Las Vegas Raiders', href: '#catalog' },
      { label: 'Philadelphia Eagles', href: '#catalog' },
      { label: 'San Francisco 49ers', href: '#catalog' },
      { label: 'Tampa Bay Buccaneers', href: '#catalog' },
    ],
    popularPicks: [
      { label: 'Top NFL Gifts', href: '#catalog' },
      { label: 'MVP Collection', href: '#catalog' },
      { label: 'Rivalry Series', href: '#catalog' },
    ],
    giftTypes: [
      { label: 'Jerseys', href: '#catalog' },
      { label: 'Autograph Displays', href: '#catalog' },
      { label: 'Super Bowl Memorabilia', href: '#catalog' },
    ],
    seasonal: {
      title: 'NFL Father\'s Day Picks',
      subtitle: 'Premium football gifts, ready to ship',
      href: '/fathers-day-2026',
    },
  },
  {
    id: 'ncaa',
    label: 'NCAA',
    status: 'live',
    audience: 'all',
    productFilters: { license_body: 'CLC' },
    teams: [
      { label: 'The University of Alabama', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'The University of Alabama' }) },
      { label: 'Arizona State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Arizona State University' }) },
      { label: 'Clemson University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Clemson University' }) },
      { label: 'Coppin State', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Coppin State' }) },
      { label: 'Eastern Michigan University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Eastern Michigan University' }) },
      { label: 'Florida State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Florida State University' }) },
      { label: 'Howard University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Howard University' }) },
      { label: 'Jackson State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Jackson State University' }) },
      { label: 'Louisiana State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Louisiana State University' }) },
      { label: 'Michigan State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Michigan State University' }) },
      { label: 'North Carolina A&T State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'North Carolina A&T State University' }) },
      { label: 'Pennsylvania State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Pennsylvania State University' }) },
      { label: 'Southern University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Southern University' }) },
      { label: 'Tennessee State University', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Tennessee State University' }) },
      { label: 'Texas A&M', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'Texas A&M' }) },
      { label: 'United States Naval Academy', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'United States Naval Academy' }) },
      { label: 'University of Florida', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of Florida' }) },
      { label: 'University of Louisville', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of Louisville' }) },
      { label: 'University of Maryland', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of Maryland' }) },
      { label: 'University of Mississippi', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of Mississippi' }) },
      { label: 'University of Oklahoma', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of Oklahoma' }) },
      { label: 'University of South Carolina', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', school: 'University of South Carolina' }) },
    ],
    conferences: NCAA_CONFERENCE_GROUPS.map((group) => ({
      label: group.label,
      teams: group.teams.map((team) => ({
        label: team.label,
        href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', conference: group.label, school: team.label }),
      })),
    })),
    popularPicks: [
      { label: 'Top NCAA Basketball Programs', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
      { label: 'Browse by Conference', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL', conference: 'SEC' }) },
      { label: 'Courtside Gift Picks', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
      { label: 'College Traditions', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
    ],
    giftTypes: [
      { label: 'Basketball Vase Gifts', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
      { label: 'Campus Collectibles', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
      { label: 'Alumni Gifts', href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }) },
    ],
    seasonal: {
      title: 'NCAA Basketball Spotlight',
      subtitle: 'Official licensed basketball vase gifts by school',
      href: buildShopHref({ license: 'CLC', sport: 'BASKETBALL' }),
    },
  },
  {
    id: 'mlb',
    label: 'MLB',
    status: 'live',
    audience: 'all',
    productFilters: { license_body: 'NONE' },
    teams: [
      { label: 'New York Yankees', href: '#catalog' },
      { label: 'Los Angeles Dodgers', href: '#catalog' },
      { label: 'Boston Red Sox', href: '#catalog' },
      { label: 'Chicago Cubs', href: '#catalog' },
    ],
    popularPicks: [
      { label: 'Classic Ballpark Picks', href: '#catalog' },
      { label: 'Hall of Fame Collection', href: '#catalog' },
    ],
    giftTypes: [
      { label: 'Signed Baseball Gifts', href: '#catalog' },
      { label: 'Home Run Collection', href: '#catalog' },
    ],
    seasonal: {
      title: 'MLB Collection',
      subtitle: 'Baseball gifts for every fan',
      href: '#catalog',
    },
  },
  {
    id: 'nba',
    label: 'NBA',
    status: 'coming_soon',
    audience: 'all',
    productFilters: { featured: true },
    teams: [],
    popularPicks: [
      { label: 'Launching Soon', href: '#catalog', tag: 'Soon' },
    ],
    giftTypes: [],
    seasonal: {
      title: 'NBA Coming Soon',
      subtitle: 'Join the waitlist for launch updates',
      href: '#catalog',
    },
  },
  {
    id: 'nhl',
    label: 'NHL',
    status: 'coming_soon',
    audience: 'all',
    productFilters: { featured: true },
    teams: [],
    popularPicks: [
      { label: 'Launching Soon', href: '#catalog', tag: 'Soon' },
    ],
    giftTypes: [],
    seasonal: {
      title: 'NHL Coming Soon',
      subtitle: 'Hockey gift collections in development',
      href: '#catalog',
    },
  },
  {
    id: 'soccer',
    label: 'Soccer',
    status: 'coming_soon',
    audience: 'all',
    productFilters: { featured: true },
    teams: [],
    popularPicks: [
      { label: 'Launching Soon', href: '#catalog', tag: 'Soon' },
    ],
    giftTypes: [],
    seasonal: {
      title: 'Soccer Coming Soon',
      subtitle: 'Global football-inspired gift drops ahead',
      href: '#catalog',
    },
  },
  {
    id: 'military',
    label: 'Military',
    status: 'live',
    audience: 'military',
    productFilters: { license_body: 'ARMY' },
    teams: [
      { label: 'Army', href: '#catalog?license=ARMY' },
      { label: 'Air Force', href: '#catalog?license=ARMY' },
      { label: 'Navy', href: '#catalog?license=ARMY' },
      { label: 'Marines', href: '#catalog?license=ARMY' },
    ],
    popularPicks: [
      { label: 'Patriot Collection', href: '#catalog?license=ARMY' },
      { label: 'Service Legacy Gifts', href: '#catalog?license=ARMY' },
    ],
    giftTypes: [
      { label: 'Military Football Gifts', href: '#catalog?license=ARMY' },
      { label: 'Honor Display Cases', href: '#catalog?license=ARMY' },
    ],
    seasonal: {
      title: 'Military Collection',
      subtitle: 'Official military-licensed products',
      href: '#catalog?license=ARMY',
    },
  },
  {
    id: 'collectibles',
    label: 'Collectibles',
    status: 'live',
    audience: 'collectors',
    productFilters: { featured: true },
    teams: [
      { label: 'Signed Editions', href: '#catalog' },
      { label: 'Limited Drops', href: '#catalog' },
      { label: 'Archive Pieces', href: '#catalog' },
    ],
    popularPicks: [
      { label: 'Collector Favorites', href: '#catalog' },
      { label: 'Premium Vault', href: '#catalog' },
    ],
    giftTypes: [
      { label: 'Display-Ready Gifts', href: '#catalog' },
      { label: 'Numbered Editions', href: '#catalog' },
    ],
    seasonal: {
      title: 'Collector Spotlight',
      subtitle: 'Curated premium collectibles',
      href: '#catalog',
    },
  },
] as const

export function getMegaNavTab(tabId: NavTabId): MegaNavTab | undefined {
  return MEGA_NAV_TABS.find((tab) => tab.id === tabId)
}

export const DEFAULT_MEGA_NAV_TAB: NavTabId = 'featured'
