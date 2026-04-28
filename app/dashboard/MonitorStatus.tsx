"use client"

import { useEffect, useMemo, useState } from "react"
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
  // PageList passes `new Date(...)` inline at every render, so the
  // incoming `lastCheckedAt` reference changes every render even
  // when the underlying time is the same. Stabilize on `.getTime()`
  // so the useEffect below doesn't tear down + restart the tick
  // interval on every parent render.
  const lastChecked = useMemo(
    () => lastCheckedAt,
    [lastCheckedAt?.getTime()],
  )
  // `formatDistanceToNowStrict(lastChecked)` is a moving target: the
  // SSR pass captures one interval, the client capture a few seconds
  // later captures a different one ("57 seconds ago" vs "1 minute
  // ago"), and React's hydration check fails. Gate the relative
  // string behind a mount flag so SSR + first client paint render the
  // SAME placeholder, then swap to the live string after mount. The
  // placeholder is identical text so there's no layout shift.
  const [mounted, setMounted] = useState(false)
  // Re-render every 10s so formatDistanceToNowStrict re-evaluates
  // against the fresh clock — short enough that "5 seconds ago"
  // updates smoothly within the first minute, cheap enough that it's
  // effectively free at the list size the dashboard shows.
  const [, setTick] = useState(0)
  useEffect(() => {
    setMounted(true)
    if (!lastChecked) return
    const id = setInterval(() => setTick((n) => n + 1), ui.MONITOR_STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [lastChecked])

  const label = running
    ? "Refreshing…"
    : lastChecked
    ? mounted
      ? `Refreshed ${formatDistanceToNowStrict(lastChecked, { addSuffix: true })}`
      : "Refreshed"
    : monitored
    ? "Awaiting refresh"
    : null
  if (!label) return null
  return (
    <span
      title="Re-checks this site's sitemap and homepage on a schedule and refreshes the llms.txt when it changes"
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
