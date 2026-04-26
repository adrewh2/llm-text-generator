"use client"

import { useEffect, useState } from "react"
import { formatDistanceToNowStrict } from "date-fns"
import { Eye } from "lucide-react"
import { ui } from "@/lib/config"

interface Props {
  monitored: boolean
  lastCheckedAt: Date | null
  /** True when a job for this page is currently in a non-terminal state. */
  running: boolean
}

export default function MonitorStatus({ monitored, lastCheckedAt, running }: Props) {
  // Re-render every 10s so formatDistanceToNowStrict re-evaluates
  // against the fresh clock — short enough that "5 seconds ago"
  // updates smoothly within the first minute, cheap enough that it's
  // effectively free at the list size the dashboard shows.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastCheckedAt) return
    const id = setInterval(() => setTick((n) => n + 1), ui.MONITOR_STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [lastCheckedAt])

  const label = running
    ? "Refreshing…"
    : lastCheckedAt
    ? `Refreshed ${formatDistanceToNowStrict(lastCheckedAt, { addSuffix: true })}`
    : monitored
    ? "Awaiting refresh"
    : null
  if (!label) return null
  return (
    <span
      title="We re-check this site's sitemap and homepage on a schedule and refresh the llms.txt when it changes"
      // Fixed width wide enough for "Refreshed N hours/minutes ago"
      // without truncation. justify-end right-aligns short labels so
      // they hug the trash/chevron column instead of leaving a visible
      // gap between the label and the row's right edge.
      className="hidden md:inline-flex w-52 justify-end items-center gap-1.5 text-xs font-medium text-zinc-600 overflow-hidden"
    >
      <Eye size={12} className="text-emerald-500 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
