"use client"

// Catches uncaught React render errors anywhere in the App Router
// tree and reports them to Sentry. Next.js replaces the normal root
// layout with this component when a render error bubbles up past
// every `error.tsx` boundary below it — so it owns the full
// document, including <html>/<body>.

import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"
import NextError from "next/error"

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  )
}
