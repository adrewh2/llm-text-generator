"use client"

import { useEffect, useRef, useState } from "react"
import type { JobStatus } from "@/lib/crawler/types"
import type { ApiJob } from "./types"

// Minimum time each pipeline step stays visible on screen during a
// live crawl. Prevents fast backend transitions (scoring → assembling
// → complete in <100ms) from flashing by unreadably. Genuinely slow
// steps are unaffected — the effect only caps how fast the *displayed*
// status can catch up to the real one.
const LIVE_MIN_STEP_DWELL_MS = 1200

// Ordered pipeline progression. "complete" is the terminal display
// state; "partial" is surfaced at the end as-is so the UI can badge it.
const STATUS_PROGRESSION = [
  "pending", "crawling", "enriching", "scoring", "assembling", "complete",
] as const
type ProgressionStatus = typeof STATUS_PROGRESSION[number]

function indexOfStatus(s: string): number {
  return STATUS_PROGRESSION.indexOf(s as ProgressionStatus)
}

/**
 * Drives a paced `visibleStatus` against the real `job.status`. Three
 * regimes:
 *   1. No job / simulation running: bail, let simulation drive the UI.
 *   2. First render with a non-pending real status (dashboard click,
 *      direct URL visit): jump straight to that status, skip pacing.
 *      Pacing is for watching *new* transitions, not re-animating
 *      history.
 *   3. Otherwise: advance one step per LIVE_MIN_STEP_DWELL_MS toward
 *      the real status.
 *
 * Failure bypasses pacing entirely — users see the error immediately.
 */
export function useVisibleStatus(
  job: ApiJob | null,
  simulationActive: boolean,
): JobStatus {
  const [visibleStatus, setVisibleStatus] = useState<JobStatus>(
    () => job?.status ?? "pending",
  )
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!job || simulationActive) return

    if (job.status === "failed") {
      setVisibleStatus("failed")
      return
    }

    if (visibleStatus === "pending" && job.status !== "pending") {
      setVisibleStatus(job.status)
      return
    }

    // Collapse "partial" into "complete" for progression purposes —
    // then surface it as partial when we actually land on that step.
    const effectiveTarget: string =
      job.status === "partial" ? "complete" : job.status
    const targetIdx = indexOfStatus(effectiveTarget)
    const currentIdx = indexOfStatus(visibleStatus)
    if (targetIdx === -1 || currentIdx === -1) return
    if (targetIdx <= currentIdx) return

    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = setTimeout(() => {
      const next = STATUS_PROGRESSION[currentIdx + 1]
      setVisibleStatus(
        next === "complete" && job.status === "partial" ? "partial" : next,
      )
    }, LIVE_MIN_STEP_DWELL_MS)
  }, [job, visibleStatus, simulationActive])

  return visibleStatus
}
