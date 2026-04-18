"use client"

import { useEffect, useState } from "react"
import { formatDistanceToNowStrict } from "date-fns"
import { Eye } from "lucide-react"

interface Props {
  monitored: boolean
  lastCheckedAt: Date | null
}

export default function MonitorStatus({ monitored, lastCheckedAt }: Props) {
  // Re-render every 10s so formatDistanceToNowStrict re-evaluates
  // against the fresh clock — short enough that "5 seconds ago"
  // updates smoothly within the first minute, cheap enough that it's
  // effectively free at the list size the dashboard shows.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastCheckedAt) return
    const id = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [lastCheckedAt])

  if (!monitored) return null
  const label = lastCheckedAt
    ? `Checked ${formatDistanceToNowStrict(lastCheckedAt, { addSuffix: true })}`
    : "Awaiting check"
  return (
    <span
      title="We re-check this site's sitemap and homepage on a schedule and regenerate llms.txt when it changes"
      // Fixed narrow width + justify-start so the Eye icon aligns
      // vertically across rows but sits close to the trash/chevron on
      // the right. Truncate so the longest label ("less than a minute
      // ago") ellipsizes rather than spilling into the next element.
      className="hidden md:inline-flex w-36 items-center gap-1.5 text-xs font-medium text-zinc-600 overflow-hidden"
    >
      <Eye size={12} className="text-emerald-500 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
