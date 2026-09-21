export * from './apparel'
export * from './commission'
export * from './consultant'
export * from './fraud'
export * from './hologram'
export * from './license'
export * from './licensed-schools'
export * from './product-categories'

// campaign.ts, bundle.ts, and fulfillment.ts are reserved, type-only stubs
// (docs/adr/0004, 0006, 0009) with no runtime logic and no backing schema
// yet — intentionally not exported here or from @gtg/api until they're
// actually implemented.
