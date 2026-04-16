import type { ReactNode } from 'react'
import { Container, Header } from '@gtg/ui'
import { ReferralCapture } from './_components/ReferralCapture'

const navItems = [
  { href: '/shop', label: 'Shop' },
  { href: '/consultant', label: 'Consultant' },
] as const

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'Inter, Helvetica Neue, Arial, sans-serif',
          background: '#f8f9fa',
          color: '#1a2033',
        }}
      >
        <ReferralCapture />
        <Container size="lg" style={{ paddingTop: 24, paddingBottom: 48 }}>
          <Header
            brandHref="/"
            brandLabel="Game Time Gift"
            links={[...navItems]}
            style={{
              marginBottom: 32,
              padding: '18px 20px',
              borderRadius: 20,
              background: 'linear-gradient(135deg, #031b52, #0f3a80)',
              color: '#ffffff',
            }}
          />
          {children}
        </Container>
      </body>
    </html>
  )
}
