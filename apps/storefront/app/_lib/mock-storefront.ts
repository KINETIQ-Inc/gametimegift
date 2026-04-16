import footballArt from '../../src/assets/football.png'
import basketballArt from '../../src/assets/basketball.png'

export interface AppRouteProduct {
  slug: string
  name: string
  price: string
  sport: string
  license: string
  summary: string
  imageSrc: string
}

export const APP_ROUTE_PRODUCTS: AppRouteProduct[] = [
  {
    slug: 'alabama-collector-football',
    name: 'Alabama Collector Football',
    price: '$139.00',
    sport: 'Football',
    license: 'CLC',
    summary: 'A crimson-forward collector piece built for premium gifting and display.',
    imageSrc: footballArt,
  },
  {
    slug: 'florida-collector-basketball',
    name: 'Florida Collector Basketball',
    price: '$129.00',
    sport: 'Basketball',
    license: 'CLC',
    summary: 'A bright blue-and-orange gift piece for alumni offices and milestone celebrations.',
    imageSrc: basketballArt,
  },
  {
    slug: 'army-collector-football',
    name: 'United States Army Collector Football',
    price: '$139.00',
    sport: 'Football',
    license: 'ARMY',
    summary: 'A service-forward collectible designed for retirement, promotion, and legacy gifting.',
    imageSrc: footballArt,
  },
]

export function findAppRouteProduct(slug: string): AppRouteProduct | null {
  return APP_ROUTE_PRODUCTS.find((product) => product.slug === slug) ?? null
}
