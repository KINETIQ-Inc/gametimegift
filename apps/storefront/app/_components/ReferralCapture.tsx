'use client'

import { useEffect } from 'react'
import { captureAppReferralCode } from '../_lib/referral-storage'

export function ReferralCapture() {
  useEffect(() => {
    captureAppReferralCode()
  }, [])

  return null
}
