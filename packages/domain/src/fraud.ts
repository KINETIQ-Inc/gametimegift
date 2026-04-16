import type { FraudFlagSeverity, LockAuthority, UserRole } from '@gtg/types'

export const AUTO_LOCK_SEVERITIES: readonly FraudFlagSeverity[] = ['high', 'critical']

export function shouldAutoLockUnit(severity: FraudFlagSeverity): boolean {
  return AUTO_LOCK_SEVERITIES.includes(severity)
}

export function canApplyFraudLock(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin'
}

export function isValidLockAuthority(value: string): value is LockAuthority {
  return value === 'gtg_admin' || value === 'clc' || value === 'army' || value === 'system'
}

export function assertLockAuthority(
  value: string,
  context = 'lockAuthority',
): asserts value is LockAuthority {
  if (!isValidLockAuthority(value)) {
    throw new Error(`[GTG] ${context} is invalid.`)
  }
}
