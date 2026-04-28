"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { LayoutDashboard, Loader2, Plus } from "lucide-react"
import type { User } from "@supabase/supabase-js"
import type { JobProgress, JobStatus } from "@/lib/crawler/types"
import type { ApiJob } from "@/app/p/[id]/types"
import { createClient } from "@/lib/supabase/client"
import { debugLog } from "@/lib/log"
import { ui } from "@/lib/config"
import AppHeader, { HEADER_BUTTON_CLASS } from "@/app/components/AppHeader"
import UserMenu from "@/app/components/UserMenu"
import ProgressPane from "@/app/p/[id]/ProgressPane"
import { useVisibleStatus } from "@/app/p/[id]/useVisibleStatus"

const { POLL_INTERVAL_MS, MAX_POLL_FAILURES } = ui

interface JobPayload {
  id: string
  pageId: string
  pageUrl: string
  status: string
  progress: JobProgress
  error: string | null
  createdAt: string
  updatedAt: string
}

export default function JobView({
  initialJob,
  initialUser,
}: {
  initialJob: JobPayload
  initialUser: User | null
}) {
  const router = useRouter()
  const [job, setJob] = useState<JobPayload>(initialJob)
  const [user, setUser] = useState<User | null>(initialUser)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollFailuresRef = useRef(0)
  const [pollDead, setPollDead] = useState(false)
  // Stash the pageId to navigate to once visibleStatus catches up to
  // the real terminal status. `useVisibleStatus` paces step transitions
  // at `LIVE_MIN_STEP_DWELL_MS` per step so the fast-tail stages
  // (scoring, assembling) don't flash by; redirecting on real-status
  // alone would cut that animation short. This holds the navigation
  // until every step has been visibly walked through.
  const [pendingRedirectPageId, setPendingRedirectPageId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${initialJob.id}`)
      if (res.status === 404) {
        // Job was force-failed by the stuck-job sweeper between mount
        // and now — treat like a terminal failure.
        if (intervalRef.current) clearInterval(intervalRef.current)
        setPollDead(true)
        return
      }
      if (!res.ok) {
        pollFailuresRef.current++
        if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
          if (intervalRef.current) clearInterval(intervalRef.current)
          setPollDead(true)
        }
        return
      }
      pollFailuresRef.current = 0
      const data: JobPayload = await res.json()
      setJob(data)

      const isTerminalSuccess = data.status === "complete" || data.status === "partial"
      if (isTerminalSuccess) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        // Stage the redirect — the effect below fires it once the
        // paced visible status reaches its terminal state, so the
        // user gets to see every step land on its green checkmark
        // before the route transition.
        setPendingRedirectPageId(data.pageId)
        return
      }
      if (data.status === "failed") {
        if (intervalRef.current) clearInterval(intervalRef.current)
        // Stay on /jobs/{id} so the user sees the error + a Try
        // another URL CTA. (Handled by ProgressPane's failed branch.)
      }
    } catch (err) {
      debugLog("JobView.fetchJob", err)
      pollFailuresRef.current++
      if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        setPollDead(true)
      }
    }
  }, [initialJob.id, router])

  useEffect(() => {
    fetchJob()
    intervalRef.current = setInterval(fetchJob, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchJob])

  // Build a minimal ApiJob shape for ProgressPane — it reads
  // url/status/error/progress only.
  const apiJobLike: ApiJob = {
    id: job.pageId,
    url: job.pageUrl,
    status: job.status as JobStatus,
    progress: job.progress,
    error: job.error ?? undefined,
    result: undefined,
    pages: undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
  const visibleStatus = useVisibleStatus(apiJobLike)
  const displayJob: ApiJob = { ...apiJobLike, status: visibleStatus }

  // Fire the staged redirect (set when the real job hit terminal
  // success) once the paced visible status reaches its matching
  // terminal state. `useVisibleStatus` advances one step per
  // LIVE_MIN_STEP_DWELL_MS toward the real status, so this guarantees
  // every progress step gets its dwell window even when the worker
  // raced through scoring + assembling in milliseconds.
  useEffect(() => {
    if (!pendingRedirectPageId) return
    if (visibleStatus !== "complete" && visibleStatus !== "partial") return
    router.replace(`/p/${pendingRedirectPageId}`)
  }, [pendingRedirectPageId, visibleStatus, router])

  return (
    <div className="h-dvh font-sans bg-white flex flex-col">
      <AppHeader
        center={
          <>
            <span className="h-4 w-px bg-zinc-200 shrink-0" aria-hidden />
            <span className="text-sm text-zinc-500 truncate">{hostnameOf(job.pageUrl)}</span>
            <span className="text-zinc-300 hidden sm:block">·</span>
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400 shrink-0">
              <Loader2 size={11} className="animate-spin" /> Generating…
            </span>
          </>
        }
        right={
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/" className={HEADER_BUTTON_CLASS} aria-label="Generate">
              <Plus size={14} className="text-zinc-400" />
              <span className="hidden sm:inline">Generate</span>
            </Link>
            {user && (
              <Link href="/dashboard" className={HEADER_BUTTON_CLASS} aria-label="Dashboard">
                <LayoutDashboard size={14} className="text-zinc-400" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
            )}
            {user && <UserMenu user={user} />}
          </div>
        }
      />

      {pollDead && (
        <div role="alert" className="bg-amber-50 border-b border-amber-100 px-6 py-2 shrink-0">
          <p className="text-xs text-amber-700">
            Lost connection to the server.{" "}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="underline font-medium"
            >
              Reload
            </button>{" "}
            to try again.
          </p>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <ProgressPane job={displayJob} />
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
