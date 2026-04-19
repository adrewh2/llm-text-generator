// Server-side Sentry init. Fires on every Fluid Compute cold start.
//
// `ignoreErrors` filters the things we expect and already handle
// gracefully — without them every SSRF block and bot-challenge hit
// would surface as a new Sentry issue and drown the signal.

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Dev-only errors (HMR transients, unfinished refactors, stale
  // caches) aren't signal. Gate on NODE_ENV so `next dev` is a
  // no-op while Vercel / `next start` still forward events.
  enabled: process.env.NODE_ENV === "production",

  // 10 % sampling on traces is plenty for volume calibration; raise
  // if we start chasing a specific perf issue.
  tracesSampleRate: 0.1,

  // These are all code paths we're deliberately catching — they're
  // product behaviour, not errors worth alerting on.
  ignoreErrors: [
    /UnsafeUrlError/,
    /Unsafe URL \(/,
    /forbidden IP range/,
    /Bot challenge page/,
    /Response too large/,
    /^HTTP 4\d\d/,      // 4xx from target sites (user-supplied URL)
    /^Timeout$/,
    /Exceeded time budget/,
  ],
})
