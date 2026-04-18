import * as Sentry from "@sentry/nextjs"

// Structured log. In production it stays quiet for string / object
// payloads (so the crawler doesn't noise up serverless logs with
// routine debug info), but ALWAYS emits when the payload is an
// `Error` — those are operational issues a reviewer needs to see in
// Vercel runtime logs. In dev everything emits.
//
// Error payloads also forward to Sentry for grouped issue tracking.
// Expected failures (SSRF rejections, bot-challenge pages, timeouts)
// are filtered by `ignoreErrors` in sentry.server.config.ts so they
// don't flood the dashboard. Non-Error payloads don't go to Sentry —
// they have no stack signature to group on.
export function debugLog(context: string, data: unknown): void {
  const isError = data instanceof Error
  if (process.env.NODE_ENV === "production" && !isError) return
  const message = isError
    ? (data.stack ?? data.message)
    : typeof data === "string"
      ? data
      : safeStringify(data)
  const method = isError ? console.error : console.warn
  method(`[${context}] ${message}`)
  if (isError) {
    Sentry.captureException(data, { tags: { context } })
  }
}

/**
 * Always emits, in any environment — use for operational errors that
 * need to be visible in production logs regardless of payload shape.
 * `debugLog` silently drops non-Error payloads in prod, which is the
 * right default for trace logging but hides genuine errors surfaced as
 * composed strings (e.g. `${url}: ${message}`). Error payloads also
 * go to Sentry for grouping / alerting.
 */
export function errorLog(context: string, data: unknown): void {
  const message = data instanceof Error
    ? (data.stack ?? data.message)
    : typeof data === "string"
      ? data
      : safeStringify(data)
  console.error(`[${context}] ${message}`)
  if (data instanceof Error) {
    Sentry.captureException(data, { tags: { context } })
  } else if (typeof data === "string") {
    Sentry.captureMessage(`[${context}] ${data}`, {
      level: "error",
      tags: { context },
    })
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
