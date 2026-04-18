import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

// Ship a conservative, modern security-header set on every response.
// `unsafe-inline` / `unsafe-eval` on script-src is the price of
// Next.js's RSC bootstrap + HMR tooling — without it React never
// hydrates and the page appears frozen. The principled alternative
// is per-request nonces via middleware; shipping that is a bigger
// change for a take-home and we'd still want `'unsafe-eval'` in
// dev anyway. `style-src 'unsafe-inline'` is likewise for Next's
// emitted hashed <style> tags.
//
// `*.ingest.sentry.io` is on connect-src so the Sentry browser SDK
// can post events; `*.sentry.io` covers session-replay / tunnel
// routes. worker-src allows the replay SDK's blob-backed worker.
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
  // Source-map upload uses the Vercel-injected SENTRY_AUTH_TOKEN /
  // SENTRY_ORG / SENTRY_PROJECT. On local dev without those vars the
  // wrapper skips the upload step silently. Source maps are deleted
  // from the build folder after upload (SDK default), so they don't
  // ship in the public bundle — internals stay Sentry-only.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Quiet CLI output unless we're on CI and want the upload
  // confirmation in the build log.
  silent: !process.env.CI,
  webpack: {
    // Strip Sentry's debug-logging branch from the client bundle —
    // we don't need its log output in production and it adds bytes.
    treeshake: { removeDebugLogging: true },
    // We already have a monitor cron and a stuck-job sweeper; no
    // need for Sentry Crons to double-track.
    automaticVercelMonitors: false,
  },
})
