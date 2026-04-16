export interface FooterLink {
  label: string
  href: string
  description?: string
}

export interface FooterColumn {
  id: string
  title: string
  links: FooterLink[]
}

export interface FooterTrustItem {
  title: string
  description: string
}

export interface FooterSocialLink {
  label: string
  href: string
  icon: 'instagram' | 'facebook' | 'youtube' | 'tiktok'
}

export interface FooterNewsletter {
  title: string
  subtitle: string
  ctaLabel: string
  ctaHref: string
}

export interface FooterLegalLink {
  label: string
  href: string
}

export interface StorefrontFooterConfig {
  columns: FooterColumn[]
  trustItems: FooterTrustItem[]
  newsletter: FooterNewsletter
  social: FooterSocialLink[]
  legal: FooterLegalLink[]
  copyright: string
}

export const STOREFRONT_FOOTER_CONFIG: StorefrontFooterConfig = {
  columns: [
    {
      id: 'shop',
      title: 'Shop Gift Collections',
      links: [
        { label: 'Sports Vases', href: '/shop', description: 'Signature arrangements and team-themed centerpieces.' },
        { label: 'Team Frames', href: '/shop', description: 'Display-ready frames for fan spaces and offices.' },
        { label: 'Wine Racks', href: '/shop', description: 'Collector-grade bottle displays with sports identity.' },
        { label: 'Signature Football Displays', href: '/shop' },
        { label: 'Limited Drops', href: '/fathers-day-2026' },
      ],
    },
    {
      id: 'authenticity',
      title: 'Authenticity & Trust',
      links: [
        { label: 'Authenticity Page', href: '/authenticity' },
        { label: 'Verify Hologram', href: '/authenticity' },
        { label: 'Licensed Products (NCAA / Military)', href: '/shop' },
        { label: 'Care & Display Guide', href: '/authenticity' },
        { label: 'Returns & Refund Policy', href: '/returns' },
      ],
    },
    {
      id: 'support',
      title: 'Services & Support',
      links: [
        { label: 'Track My Order', href: '/track-order' },
        { label: 'Shipping & Delivery', href: '/shipping' },
        { label: 'Contact Support', href: '/contact' },
        { label: 'FAQ', href: '/faq' },
        { label: 'Gift Cards', href: '/gift-cards' },
      ],
    },
    {
      id: 'company',
      title: 'Business & Company',
      links: [
        { label: 'Bulk / Corporate Gifts', href: '/corporate-gifts' },
        { label: 'Affiliate Program', href: '/affiliate' },
        { label: 'About GTG', href: '/about' },
        { label: 'Careers', href: '/careers' },
        { label: 'Press / Partnerships', href: '/partnerships' },
      ],
    },
  ],
  trustItems: [
    {
      title: 'Officially Licensed',
      description: 'NCAA and military-licensed products with validated source records.',
    },
    {
      title: 'Authenticity Verified',
      description: 'Every collectible can be checked through GTG hologram verification.',
    },
    {
      title: 'Secure Checkout',
      description: 'Protected payments and audited order processing flow.',
    },
    {
      title: 'Easy Returns',
      description: 'Straightforward return support for eligible purchases.',
    },
  ],
  newsletter: {
    title: 'Get Early Access to New Drops',
    subtitle: 'New sports decor collections, limited releases, and seasonal gift launches.',
    ctaLabel: 'Sign Up & Save',
    ctaHref: '/newsletter',
  },
  social: [
    { label: 'Facebook', href: 'https://facebook.com', icon: 'facebook' },
    { label: 'Instagram', href: 'https://instagram.com', icon: 'instagram' },
    { label: 'TikTok', href: 'https://tiktok.com', icon: 'tiktok' },
    { label: 'YouTube', href: 'https://youtube.com', icon: 'youtube' },
  ],
  legal: [
    { label: 'Privacy Policy', href: '/privacy' },
    { label: 'Terms of Use', href: '/terms' },
    { label: 'Accessibility', href: '/accessibility' },
    { label: 'Cookie Preferences', href: '/cookies' },
  ],
  copyright: '© 2026 Game Time Gift. All Rights Reserved.',
}
