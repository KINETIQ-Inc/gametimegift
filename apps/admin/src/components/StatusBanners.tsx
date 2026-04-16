import { AlertBanner } from '@gtg/ui'

interface StatusBannersProps {
  errorMessage: string | null
  successMessage: string | null
  /** When provided, a "Try again" button is rendered inside the error banner. */
  onRetry?: () => void
}

export function StatusBanners({ errorMessage, successMessage, onRetry }: StatusBannersProps) {
  return (
    <>
      {errorMessage ? (
        <AlertBanner kind="error" actionLabel={onRetry ? 'Try again' : undefined} onAction={onRetry}>
          {errorMessage}
        </AlertBanner>
      ) : null}
      {successMessage ? <AlertBanner kind="success">{successMessage}</AlertBanner> : null}
    </>
  )
}
