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
      { label: 'The University of Alabama', href: '#catalog?license=CLC' },
      { label: 'Arizona State University', href: '#catalog?license=CLC' },
      { label: 'Clemson University', href: '#catalog?license=CLC' },
      { label: 'Coppin State', href: '#catalog?license=CLC' },
      { label: 'Eastern Michigan University', href: '#catalog?license=CLC' },
      { label: 'Florida State University', href: '#catalog?license=CLC' },
      { label: 'Howard University', href: '#catalog?license=CLC' },
      { label: 'Jackson State University', href: '#catalog?license=CLC' },
      { label: 'Louisiana State University', href: '#catalog?license=CLC' },
      { label: 'Michigan State University', href: '#catalog?license=CLC' },
      { label: 'North Carolina A&T State University', href: '#catalog?license=CLC' },
      { label: 'Pennsylvania State University', href: '#catalog?license=CLC' },
      { label: 'Southern University', href: '#catalog?license=CLC' },
      { label: 'Tennessee State University', href: '#catalog?license=CLC' },
      { label: 'Texas A&M', href: '#catalog?license=CLC' },
      { label: 'United States Naval Academy', href: '#catalog?license=CLC' },
      { label: 'University of Florida', href: '#catalog?license=CLC' },
      { label: 'University of Louisville', href: '#catalog?license=CLC' },
      { label: 'University of Maryland', href: '#catalog?license=CLC' },
      { label: 'University of Mississippi', href: '#catalog?license=CLC' },
      { label: 'University of Oklahoma', href: '#catalog?license=CLC' },
      { label: 'University of South Carolina', href: '#catalog?license=CLC' },
    ],
    conferences: [
      {
        label: 'SEC',
        teams: [
          { label: 'The University of Alabama', href: '#catalog?license=CLC&conference=SEC' },
          { label: 'Louisiana State University', href: '#catalog?license=CLC&conference=SEC' },
          { label: 'University of Florida', href: '#catalog?license=CLC&conference=SEC' },
          { label: 'University of Oklahoma', href: '#catalog?license=CLC&conference=SEC' },
          { label: 'University of South Carolina', href: '#catalog?license=CLC&conference=SEC' },
        ],
      },
      {
        label: 'Big Ten',
        teams: [
          { label: 'Michigan State University', href: '#catalog?license=CLC&conference=BigTen' },
          { label: 'Pennsylvania State University', href: '#catalog?license=CLC&conference=BigTen' },
          { label: 'University of Maryland', href: '#catalog?license=CLC&conference=BigTen' },
        ],
      },
      {
        label: 'ACC',
        teams: [
          { label: 'Clemson University', href: '#catalog?license=CLC&conference=ACC' },
          { label: 'Florida State University', href: '#catalog?license=CLC&conference=ACC' },
          { label: 'University of Louisville', href: '#catalog?license=CLC&conference=ACC' },
        ],
      },
      {
        label: 'Big 12',
        teams: [
          { label: 'Arizona State University', href: '#catalog?license=CLC&conference=Big12' },
        ],
      },
      {
        label: 'SWAC',
        teams: [
          { label: 'Jackson State University', href: '#catalog?license=CLC&conference=SWAC' },
          { label: 'Southern University', href: '#catalog?license=CLC&conference=SWAC' },
        ],
      },
      {
        label: 'MEAC',
        teams: [
          { label: 'Coppin State', href: '#catalog?license=CLC&conference=MEAC' },
          { label: 'Howard University', href: '#catalog?license=CLC&conference=MEAC' },
          { label: 'North Carolina A&T State University', href: '#catalog?license=CLC&conference=MEAC' },
        ],
      },
      {
        label: 'Independent / Other',
        teams: [
          { label: 'Eastern Michigan University', href: '#catalog?license=CLC' },
          { label: 'Tennessee State University', href: '#catalog?license=CLC' },
          { label: 'Texas A&M', href: '#catalog?license=CLC' },
          { label: 'United States Naval Academy', href: '#catalog?license=CLC' },
          { label: 'University of Mississippi', href: '#catalog?license=CLC' },
        ],
      },
    ],
    popularPicks: [
      { label: 'Top NCAA Programs', href: '#catalog?license=CLC' },
      { label: 'Browse by Conference', href: '#catalog?license=CLC&view=conference' },
      { label: 'Game Day Legends', href: '#catalog?license=CLC' },
      { label: 'College Traditions', href: '#catalog?license=CLC' },
    ],
    giftTypes: [
      { label: 'Football Gift Sets', href: '#catalog?license=CLC' },
      { label: 'Campus Collectibles', href: '#catalog?license=CLC' },
      { label: 'Alumni Gifts', href: '#catalog?license=CLC' },
    ],
    seasonal: {
      title: 'NCAA Spotlight',
      subtitle: 'Official licensed college team gifts',
      href: '#catalog?license=CLC',
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
