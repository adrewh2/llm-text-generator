"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { LayoutDashboard, Loader2, Plus, Shield } from "lucide-react"
import Link from "next/link"
import { validateLlmsTxt } from "@/lib/crawler/validate"
import { createClient } from "@/lib/supabase/client"
import { debugLog } from "@/lib/log"
import { ui } from "@/lib/config"
import ProgressPane from "./ProgressPane"
import ResultPane from "./ResultPane"
import { useVisibleStatus } from "./useVisibleStatus"
import type { ApiJob } from "./types"

const { SIM_STEP_DURATIONS_MS: SIM_STEP_DURATIONS, JOB_CACHE_MAX, POLL_INTERVAL_MS, MAX_POLL_FAILURES } = ui
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
// Shared browser client listens for auth state so the cached job
// metadata is cleared when a user signs out — prevents a past user's
// history from bleeding into a new session on a shared device. Auth
// state for rendering purposes is tracked per-component below; this
// listener only touches the module-level cache.
if (typeof window !== "undefined") {
  const supabase = createClient()
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") jobCache.clear()
  })
}

function PageViewInner() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const shouldSimulate = searchParams?.get("simulate") === "1"
  const pageId = params?.id

  const [job, setJob] = useState<ApiJob | null>(() => (pageId ? cacheGetJob(pageId) ?? null : null))
  const [notFound, setNotFound] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState(false)
  // Start simulated progress at step 0 when the URL asks for it — otherwise
  // a cached job (already status=complete on first fetch) briefly paints
  // the result pane before the simulation timers get a chance to kick in.
  const [simulatedStep, setSimulatedStep] = useState<number | null>(shouldSimulate ? 0 : null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const simulationStarted = useRef(false)
  // Track shouldSimulate via a ref so fetchJob's useCallback identity
  // doesn't change when we strip ?simulate=1 from the URL. If fetchJob
  // re-created, the parent useEffect would clean up simTimerRef and
  // the simulation would freeze mid-flight.
  const shouldSimulateRef = useRef(shouldSimulate)
  useEffect(() => { shouldSimulateRef.current = shouldSimulate }, [shouldSimulate])
  // Circuit breaker: after MAX_POLL_FAILURES consecutive polling
  // failures, stop polling and show an error. Prevents grinding a
  // dead endpoint forever if the server starts consistently 5xx-ing.
  const pollFailuresRef = useRef(0)
  const [pollDead, setPollDead] = useState(false)

  // Track auth state for the lifetime of this page. `getUser` settles
  // the initial value; `onAuthStateChange` covers subsequent
  // sign-in / sign-out / token-refresh events (including the
  // INITIAL_SESSION event Supabase fires on first subscribe when a
  // user is already authenticated — which the previous module-level
  // cache was silently dropping).
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => setIsSignedIn(!!data.user))
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setIsSignedIn(!!session?.user),
    )
    return () => subscription.unsubscribe()
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
      if (!res.ok) {
        pollFailuresRef.current++
        if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
          if (intervalRef.current) clearInterval(intervalRef.current)
          setPollDead(true)
        }
        return
      }
      pollFailuresRef.current = 0
      const data: ApiJob = await res.json()
      cacheSetJob(pageId, data)
      setJob(data)

      const isDone = data.status === "complete" || data.status === "partial"
      const isFailed = data.status === "failed"

      if (isDone || isFailed) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        if (isDone && shouldSimulateRef.current && !simulationStarted.current) {
          simulationStarted.current = true
          startSimulation()
          // Clean the URL so the stepper-simulation isn't replayed for
          // anyone who bookmarks, refreshes, or shares this page.
          // `simulationStarted.current` guards re-entry — even if
          // useSearchParams somehow re-fires with simulate gone, we
          // won't double-start.
          stripQueryParam("simulate")
        }
      } else if (shouldSimulateRef.current && !simulationStarted.current) {
        // Job still running but URL asked to simulate — show real progress.
        setSimulatedStep(null)
      }
    } catch (err) {
      debugLog("PageView.fetchJob", err)
      pollFailuresRef.current++
      if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        setPollDead(true)
      }
    }
  }, [pageId, startSimulation])

  useEffect(() => {
    fetchJob()
    intervalRef.current = setInterval(fetchJob, POLL_INTERVAL_MS)
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
  const result = showResult ? job?.result : undefined
  const validation = result ? validateLlmsTxt(result) : null

  return (
    <div className="h-screen font-sans bg-white flex flex-col">
      <header className="border-b border-zinc-100 px-6 py-3 flex items-center gap-4 shrink-0">
        <Link href="/" className="flex items-center gap-2 mr-2 shrink-0" aria-label="Home">
          <div className="w-5 h-5 bg-zinc-950 rounded-[4px] flex items-center justify-center">
            <span className="text-white font-mono text-[8px] font-bold">{"//"}</span>
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
            href="/"
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

      {pollDead && (
        <div role="alert" className="bg-amber-50 border-b border-amber-100 px-6 py-2 shrink-0">
          <p className="text-xs text-amber-700">
            Lost connection to the server. <button type="button" onClick={() => window.location.reload()} className="underline font-medium">Reload</button> to try again.
          </p>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {!job ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={24} className="text-zinc-400 animate-spin" />
          </div>
        ) : showResult && job.result ? (
          <ResultPane job={job} />
        ) : displayJob ? (
          <ProgressPane
            job={displayJob}
            simulatedStep={simulatedStep !== null ? simulatedStep : undefined}
          />
        ) : null}
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Remove a single query param from the browser URL without routing. */
function stripQueryParam(name: string): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (!url.searchParams.has(name)) return
  url.searchParams.delete(name)
  const qs = url.searchParams.toString()
  window.history.replaceState(
    null, "",
    `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`,
  )
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
