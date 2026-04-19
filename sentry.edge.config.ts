// Edge-runtime Sentry init. Middleware is the only edge surface we
// ship today, so this catches session-refresh / auth errors that
// never reach the Node runtime configs.

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Same dev-gate as the other two configs — no reason to forward
  // middleware errors from `next dev`.
  enabled: process.env.NODE_ENV === "production",
  tracesSampleRate: 0.1,
})
