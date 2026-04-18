// Dev-only structured log. No-op in production so we don't noise up
// serverless logs, and no-op on the client when NODE_ENV is inlined
// as "production" at build time.
export function debugLog(context: string, data: unknown): void {
  if (process.env.NODE_ENV === "production") return
  const message =
    data instanceof Error
      ? data.stack ?? data.message
      : typeof data === "string"
      ? data
      : safeStringify(data)
  console.warn(`[${context}] ${message}`)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
