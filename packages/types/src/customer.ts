export interface CustomerAddress {
  readonly line1: string
  readonly line2: string | null
  readonly city: string
  readonly state: string
  readonly postalCode: string
  readonly country: string
}

export interface CustomerProfile {
  readonly id: string
  readonly authUserId: string
  readonly email: string
  readonly fullName: string | null
  readonly phone: string | null
  readonly defaultShippingAddress: CustomerAddress | null
  readonly marketingEmailOptIn: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
