"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { LayoutDashboard, Loader2, Plus, Shield } from "lucide-react"
import Link from "next/link"
import { validateLlmsTxt } from "@/lib/crawler/validate"
import { createClient } from "@/lib/supabase/client"
import { debugLog } from "@/lib/log"
import ProgressPane from "./ProgressPane"
import ResultPane from "./ResultPane"
import { useVisibleStatus } from "./useVisibleStatus"
import type { ApiJob } from "./types"

// Simulated step durations (ms) for cached results — one per step.
const SIM_STEP_DURATIONS = [1800, 1600, 1400, 1200]

// Module-level cache — persists across remounts so navigation is
// flicker-free. Bounded as an LRU so a long-lived browser session
// can't leak memory by accumulating every visited job id.
const JOB_CACHE_MAX = 30
const jobCache = new Map<string, ApiJob>()
function cacheGetJob(id: string): ApiJob | undefined {
  const job = jobCache.get(id)
  if (job) { jobCache.delete(id); jobCache.set(id, job) } // touch
  return job
}
function cacheSetJob(id: string, job: ApiJob): void {
  if (jobCache.has(id)) jobCache.delete(id)
  jobCache.set(id, job)
  while (jobCache.size > JOB_CACHE_MAX) {
    const oldest = jobCache.keys().next().value
    if (oldest === undefined) break
    jobCache.delete(oldest)
  }
}
let cachedSignedIn: boolean | null = null

// Shared browser client listens for auth state so that when a user
// signs out, the cached job metadata is cleared. Prevents a past
// user's history from bleeding into a new session on a shared device.
if (typeof window !== "undefined") {
  const supabase = createClient()
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      jobCache.clear()
      cachedSignedIn = false
    }
    if (event === "SIGNED_IN") {
      cachedSignedIn = true
    }
  })
}

function PageViewInner() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const shouldSimulate = searchParams?.get("simulate") === "1"
  const pageId = params?.id

  const [job, setJob] = useState<ApiJob | null>(() => (pageId ? cacheGetJob(pageId) ?? null : null))
  const [notFound, setNotFound] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState<boolean>(cachedSignedIn ?? false)
  // Start simulated progress at step 0 when the URL asks for it — otherwise
  // a cached job (already status=complete on first fetch) briefly paints
  // the result pane before the simulation timers get a chance to kick in.
  const [simulatedStep, setSimulatedStep] = useState<number | null>(shouldSimulate ? 0 : null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const simulationStarted = useRef(false)

  useEffect(() => {
    if (cachedSignedIn !== null) return
    createClient().auth.getUser().then(({ data }) => {
      cachedSignedIn = !!data.user
      setIsSignedIn(cachedSignedIn)
    })
  }, [])

  const startSimulation = useCallback(() => {
    setSimulatedStep(0)
    let step = 0
    const advance = () => {
      step++
      if (step >= SIM_STEP_DURATIONS.length) {
        setSimulatedStep(null)
        return
      }
      setSimulatedStep(step)
      simTimerRef.current = setTimeout(advance, SIM_STEP_DURATIONS[step])
    }
    simTimerRef.current = setTimeout(advance, SIM_STEP_DURATIONS[0])
  }, [])

  const fetchJob = useCallback(async () => {
    if (!pageId) return
    try {
      const res = await fetch(`/api/p/${pageId}`)
      if (res.status === 404) { setNotFound(true); return }
      if (!res.ok) return
      const data: ApiJob = await res.json()
      cacheSetJob(pageId, data)
      setJob(data)

      const isDone = data.status === "complete" || data.status === "partial"
      const isFailed = data.status === "failed"

      if (isDone || isFailed) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        if (isDone && shouldSimulate && !simulationStarted.current) {
          simulationStarted.current = true
          startSimulation()
        }
      } else if (shouldSimulate && !simulationStarted.current) {
        // Job still running but URL asked to simulate — show real progress.
        setSimulatedStep(null)
      }
    } catch (err) {
      debugLog("PageView.fetchJob", err)
    }
  }, [pageId, shouldSimulate, startSimulation])

  useEffect(() => {
    fetchJob()
    intervalRef.current = setInterval(fetchJob, 1500)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (simTimerRef.current) clearTimeout(simTimerRef.current)
    }
  }, [fetchJob])

  const visibleStatus = useVisibleStatus(job, simulatedStep !== null)

  if (notFound) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 mb-4">Page not found.</p>
          <Link href="/" className="text-sm text-zinc-900 underline">Generate a new llms.txt</Link>
        </div>
      </div>
    )
  }

  // When a simulation is running, visibleStatus is irrelevant — the
  // simulated-step UI controls the view. Otherwise, clamp the job's
  // status to visibleStatus so fast live-crawl transitions are paced.
  const displayJob: ApiJob | null = job
    ? simulatedStep !== null
      ? job
      : { ...job, status: visibleStatus }
    : null
  const isDone = !!displayJob && (displayJob.status === "complete" || displayJob.status === "partial")
  const showResult = isDone && simulatedStep === null
  const domain = job ? hostnameOf(job.url) : ""
  const crawledCount = (job?.pages ?? []).filter((p) => p.fetchStatus === "ok").length
  // Only validate once we have a non-empty result — otherwise a
  // half-propagated write (job.status=complete before pages.result lands)
  // would trip "missing H1" on empty text. The store writes pages first,
  // so this is belt-and-suspenders.
  const validation = showResult && job!.result ? validateLlmsTxt(job!.result) : null

  return (
    <div className="h-screen font-sans bg-white flex flex-col">
      <header className="border-b border-zinc-100 px-6 py-3 flex items-center gap-4 shrink-0">
        <Link href="/" className="flex items-center gap-2 mr-2 shrink-0" aria-label="Home">
          <div className="w-5 h-5 bg-zinc-950 rounded-[4px] flex items-center justify-center">
            <span className="text-white font-mono text-[8px] font-bold">//</span>
          </div>
        </Link>
        <div className="h-4 w-px bg-zinc-200 shrink-0" />

        <div className="flex items-center gap-2 flex-1 min-w-0">
          {domain
            ? <span className="text-sm text-zinc-500 hidden sm:block truncate">{domain}</span>
            : <div className="h-3 w-32 bg-zinc-100 rounded animate-pulse hidden sm:block" />
          }
          {showResult ? (
            <>
              <span className="text-zinc-300 hidden sm:block">·</span>
              <span className="text-xs text-zinc-400 font-mono hidden sm:block shrink-0">{crawledCount} pages</span>
              {job!.genre && <span className="text-xs text-zinc-400 font-mono hidden md:block shrink-0">· {job!.genre.replace(/_/g, " ")}</span>}
              {validation && (
                <span className={`flex items-center gap-1.5 ml-1 text-xs font-medium px-2.5 py-1 rounded-full ring-1 shrink-0 ${
                  validation.valid
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
                    : "bg-red-50 text-red-600 ring-red-100"
                }`}>
                  <Shield size={11} />
                  {validation.valid ? "Spec valid" : `${validation.errors.length} issue${validation.errors.length > 1 ? "s" : ""}`}
                </span>
              )}
            </>
          ) : job && !isDone ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400 shrink-0">
              <Loader2 size={11} className="animate-spin" /> Generating…
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/?focus=1"
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-all"
          >
            <Plus size={12} className="text-zinc-400" />
            Generate
          </Link>
          {isSignedIn && (
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 bg-zinc-50 hover:bg-zinc-100 px-3 py-1.5 rounded-lg border border-zinc-200 transition-all"
            >
              <LayoutDashboard size={12} /> Dashboard
            </Link>
          )}
        </div>
      </header>

      {validation && !validation.valid && (
        <div className="bg-red-50 border-b border-red-100 px-6 py-2 shrink-0">
          <ul className="text-xs text-red-600 space-y-0.5">
            {validation.errors.slice(0, 3).map((e, i) => (
              <li key={i}>{e.line ? `Line ${e.line}: ` : ""}{e.message}</li>
            ))}
            {validation.errors.length > 3 && <li className="text-red-400">+{validation.errors.length - 3} more issues</li>}
          </ul>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {!job ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={24} className="text-zinc-400 animate-spin" />
          </div>
        ) : showResult && job.result ? (
          <ResultPane job={job} />
        ) : (
          <ProgressPane
            job={displayJob!}
            simulatedStep={simulatedStep !== null ? simulatedStep : undefined}
          />
        )}
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function PageViewFallback() {
  return (
    <div className="h-screen flex items-center justify-center bg-white">
      <Loader2 size={24} className="text-zinc-400 animate-spin" />
    </div>
  )
}

export default function PageView() {
  return (
    <Suspense fallback={<PageViewFallback />}>
      <PageViewInner />
    </Suspense>
  )
}
