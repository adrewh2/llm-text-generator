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
