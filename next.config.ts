import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

// script-src 'unsafe-inline' + 'unsafe-eval' are required by Next's
// RSC bootstrap and HMR; style-src 'unsafe-inline' by its hashed
// <style> tags. Sentry domains are allowed on connect-src + worker-src
// for event posting and session replay.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io https://*.sentry.io",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ")

const securityHeaders = [
  { key: "Content-Security-Policy",   value: CSP },
  { key: "X-Frame-Options",           value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options",    value: "nosniff" },
  { key: "Referrer-Policy",           value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
]

const config: NextConfig = {
  serverExternalPackages: ["cheerio"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default withSentryConfig(config, {
  // Source-map upload is a no-op locally (env vars only present on
  // Vercel). Maps are deleted post-upload so they never ship publicly.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  webpack: {
    treeshake: { removeDebugLogging: true },
    automaticVercelMonitors: false,
  },
})
