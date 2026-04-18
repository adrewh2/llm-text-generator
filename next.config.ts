import type { NextConfig } from "next"

// Ship a conservative, modern security-header set on every response.
// `unsafe-inline` / `unsafe-eval` on script-src is the price of
// Next.js's RSC bootstrap + HMR tooling — without it React never
// hydrates and the page appears frozen. The principled alternative
// is per-request nonces via middleware; shipping that is a bigger
// change for a take-home and we'd still want `'unsafe-eval'` in
// dev anyway. `style-src 'unsafe-inline'` is likewise for Next's
// emitted hashed <style> tags.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
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

export default config
