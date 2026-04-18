import type { NextConfig } from "next"

// Ship a conservative, modern security-header set on every response.
// `unsafe-inline` on style-src is the price of Next.js's emitted
// hashed <style> tags; script-src stays 'self' (no inline JS).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
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
