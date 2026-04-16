import type { CSSProperties, ReactNode } from 'react'

const cardShadow = '0 14px 36px rgba(3, 27, 82, 0.08)'

export type AppPageState = 'loading' | 'empty' | 'error' | 'success'

export function appCardStyle(overrides?: CSSProperties): CSSProperties {
  return {
    padding: 28,
    borderRadius: 24,
    background: '#ffffff',
    boxShadow: cardShadow,
    ...overrides,
  }
}

export function AppRouteSection(props: {
  eyebrow: string
  title: string
  description: ReactNode
  children?: ReactNode
}) {
  const { eyebrow, title, description, children } = props

  return (
    <section style={appCardStyle()}>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: '#92600a',
          fontWeight: 800,
        }}
      >
        {eyebrow}
      </p>
      <h2 style={{ margin: '10px 0 12px', fontSize: 36 }}>{title}</h2>
      <div style={{ margin: 0, lineHeight: 1.6 }}>{description}</div>
      {children ? <div style={{ marginTop: 22 }}>{children}</div> : null}
    </section>
  )
}

export function AppActionLink(props: {
  href: string
  label: string
  tone?: 'gold' | 'navy' | 'light'
}) {
  const { href, label, tone = 'gold' } = props

  const toneStyles: Record<string, CSSProperties> = {
    gold: {
      background: 'linear-gradient(135deg, #d7b061, #c59a4c)',
      color: '#031b52',
      border: '0',
    },
    navy: {
      background: '#031b52',
      color: '#ffffff',
      border: '0',
    },
    light: {
      background: 'rgba(255,255,255,0.08)',
      color: '#ffffff',
      border: '1px solid rgba(255,255,255,0.16)',
    },
  }

  return (
    <a
      href={href}
      style={{
        display: 'inline-flex',
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 18px',
        borderRadius: 999,
        textDecoration: 'none',
        fontWeight: 800,
        ...toneStyles[tone],
      }}
    >
      {label}
    </a>
  )
}

export function AppRouteGrid({ children }: { children: ReactNode }) {
  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 18,
      }}
    >
      {children}
    </section>
  )
}

export function AppStatePanel(props: {
  kind: AppPageState
  title: string
  message: ReactNode
}) {
  const { kind, title, message } = props

  const toneByKind: Record<string, CSSProperties> = {
    loading: {
      background: '#eef3fb',
      border: '1px solid rgba(15, 58, 128, 0.12)',
      color: '#1a2033',
    },
    empty: {
      background: '#f8f9fa',
      border: '1px dashed rgba(74, 85, 104, 0.28)',
      color: '#1a2033',
    },
    error: {
      background: '#fee2e2',
      border: '1px solid rgba(220, 38, 38, 0.24)',
      color: '#991b1b',
    },
    success: {
      background: '#dcfce7',
      border: '1px solid rgba(22, 163, 74, 0.24)',
      color: '#166534',
    },
  }

  return (
    <div
      style={{
        padding: 18,
        borderRadius: 18,
        lineHeight: 1.6,
        ...toneByKind[kind],
      }}
    >
      <strong style={{ display: 'block', marginBottom: 6 }}>{title}</strong>
      <div>{message}</div>
    </div>
  )
}

export function parseAppPageState(value?: string): AppPageState | null {
  if (value === 'loading' || value === 'empty' || value === 'error' || value === 'success') {
    return value
  }

  return null
}
