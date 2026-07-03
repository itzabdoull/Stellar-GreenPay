import { NextResponse, type NextRequest } from 'next/server'

const STELLAR_CONNECT = [
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
  'https://soroban-testnet.stellar.org',
  'https://soroban.stellar.org',
  'https://friendbot.stellar.org',
].join(' ')

function buildCsp(nonce: string, isWidget: boolean): string {
  // API origin: 'self' covers same-origin deploys; localhost:4000 covers local dev.
  const connectSrc = [
    "'self'",
    STELLAR_CONNECT,
    'https://api.coingecko.com',
    'http://localhost:4000',
  ].join(' ')

  const directives = [
    "default-src 'self'",
    // nonce tags the Next.js script injection; strict-dynamic propagates trust to bundles
    // it loads; unsafe-inline is a no-op in CSP3 but keeps CSP2 browsers working.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isWidget ? "frame-ancestors *" : "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]

  return directives.join('; ')
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const isWidget = request.nextUrl.pathname.startsWith('/widget/')
  const csp = buildCsp(nonce, isWidget)

  const requestHeaders = new Headers(request.headers)
  // x-nonce is read in pages/_document.tsx to stamp <Head> and <NextScript>
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  
  const isTestOrDev = process.env.NODE_ENV === 'development' || 
                      (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL.includes('localhost'));
                      
  if (!isTestOrDev) {
    response.headers.set('Content-Security-Policy', csp)
  }

  return response
}

export const config = {
  // Skip static assets — CSP is only meaningful on HTML responses.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|ico|svg|webp)$).*)'],
}
