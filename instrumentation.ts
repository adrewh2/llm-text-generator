// Sentry Next.js hook — loads the runtime-specific init at boot.
// `onRequestError` is Next's standard hook for reporting server-side
// render / route errors; routing it to Sentry is how they surface in
// the dashboard as grouped issues rather than just Vercel log noise.

import * as Sentry from "@sentry/nextjs"

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

export const onRequestError = Sentry.captureRequestError
