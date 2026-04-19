// Client-side Sentry init. Runs in every browser tab that loads our
// bundle. DSN is public (NEXT_PUBLIC_*) by design — it's an ingest-
// only identifier, not a secret.
//
// Replay config: zero session sampling, 100 % on-error — replays only
// fire when an error actually occurs, which keeps us well inside the
// free-tier quota (50 replays/month) while still capturing the
// sequence that preceded any surfaced issue.

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Dev HMR routinely throws transient ReferenceErrors on stale
  // cached JSX during fast-refresh — noise that doesn't reflect prod
  // behaviour. Gate on NODE_ENV so `next dev` is a no-op while
  // `next start` + Vercel deploys still forward events.
  enabled: process.env.NODE_ENV === "production",
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
