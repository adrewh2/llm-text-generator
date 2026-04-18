// Edge-runtime Sentry init. Middleware is the only edge surface we
// ship today, so this catches session-refresh / auth errors that
// never reach the Node runtime configs.

import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
})
