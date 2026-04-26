import { BrowserRouter } from 'react-router-dom'
import { StorefrontSessionProvider } from './contexts/StorefrontSessionContext'
import App from './App'

export function StorefrontErrorScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'linear-gradient(180deg, #fff8f5 0%, #ffffff 100%)',
        color: '#1a2033',
      }}
      role="alert"
      aria-live="assertive"
    >
      <div style={{ maxWidth: 720, textAlign: 'left' }}>
        <p style={{ margin: '0 0 12px', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, color: '#9c2f10' }}>
          Startup Error
        </p>
        <h1 style={{ margin: '0 0 12px', fontSize: 32, lineHeight: 1.1 }}>
          The storefront could not finish loading
        </h1>
        <p style={{ margin: '0 0 16px', fontSize: 16, lineHeight: 1.6 }}>
          The app hit a configuration or startup problem before React could render normally.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 16,
            borderRadius: 12,
            background: '#1a2033',
            color: '#f6f8ff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {message}
        </pre>
      </div>
    </div>
  )
}

export function BootstrapApp() {
  return (
    <StorefrontSessionProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StorefrontSessionProvider>
  )
}
