"use client"

import { useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { Eye } from "lucide-react"

interface Props {
  monitored: boolean
  lastCheckedAt: Date | null
}

export default function MonitorStatus({ monitored, lastCheckedAt }: Props) {
  // Bump a counter every 30s so formatDistanceToNow re-evaluates
  // against the fresh clock. The stored timestamp itself doesn't
  // change — we're just forcing a re-render to re-compute the
  // relative label.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastCheckedAt) return
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [lastCheckedAt])

  if (!monitored) return null
  const label = lastCheckedAt
    ? `Checked ${formatDistanceToNow(lastCheckedAt, { addSuffix: true }).replace("less than a minute ago", "< 1 min ago")}`
    : "Awaiting check"
  return (
    <span
      title="We re-check this site's sitemap and homepage every hour and regenerate llms.txt when it changes"
      className="hidden md:inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600"
    >
      <Eye size={12} className="text-emerald-500" />
      {label}
    </span>
  )
}
