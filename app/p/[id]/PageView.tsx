"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { LayoutDashboard, Loader2, Plus, Shield } from "lucide-react"
import Link from "next/link"
import type { User } from "@supabase/supabase-js"
import { validateLlmsTxt } from "@/lib/crawler/output/validate"
import { createClient } from "@/lib/supabase/client"
import { debugLog } from "@/lib/log"
import { ui } from "@/lib/config"
import AppHeader, { HEADER_BUTTON_CLASS } from "@/app/components/AppHeader"
import UserMenu from "@/app/components/UserMenu"
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
// Auth listener lives inside PageViewInner so HMR and unmount clean
// it up. SIGNED_OUT clears jobCache to prevent cross-session bleed.

function PageViewInner({
  initialJob,
  initialUser,
}: {
  initialJob: ApiJob | null
  initialUser: User | null
}) {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const shouldSimulate = searchParams?.get("simulate") === "1"
  const pageId = params?.id

  // Seed order: tab-local cache → server-rendered initial → null.
  // The tab cache wins because it's the freshest snapshot this tab
  // has seen (including any mid-poll updates); the server-rendered
  // payload is the next-best thing and removes the empty-shell flash
  // on first navigation.
  const [job, setJob] = useState<ApiJob | null>(() =>
    (pageId ? cacheGetJob(pageId) : null) ?? initialJob,
  )
  const [notFound, setNotFound] = useState(false)
  const [user, setUser] = useState<User | null>(initialUser)
  // Seed at step 0 so a cached (already-complete) job doesn't flash the
  // result pane before the simulation timers kick in.
  const [simulatedStep, setSimulatedStep] = useState<number | null>(shouldSimulate ? 0 : null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const simulationStarted = useRef(false)
  // Ref, not state — otherwise fetchJob's useCallback identity would
  // churn when we strip ?simulate=1 from the URL and the parent effect
  // would clean up simTimerRef mid-simulation.
  const shouldSimulateRef = useRef(shouldSimulate)
  useEffect(() => { shouldSimulateRef.current = shouldSimulate }, [shouldSimulate])
  // Circuit breaker: stop polling after MAX_POLL_FAILURES in a row.
  const pollFailuresRef = useRef(0)
  const [pollDead, setPollDead] = useState(false)

  // Track auth state for the lifetime of this page. `getUser` settles
  // the initial value; `onAuthStateChange` covers subsequent
  // sign-in / sign-out / token-refresh events (including the
  // INITIAL_SESSION event Supabase fires on first subscribe when a
  // user is already authenticated). The SIGNED_OUT branch clears the
  // per-tab job cache so a prior user's in-flight data can't leak
  // into the next session on a shared device.
  useEffect(() => {
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setUser(session?.user ?? null)
        if (event === "SIGNED_OUT") jobCache.clear()
      },
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
    // Skip the initial fetch + polling when SSR already seeded a
    // terminal job — we'd otherwise spend one /api/p/{id} round-trip
    // on every page open to re-confirm state that's already on the
    // page. A monitor re-crawl that happens after SSR will be picked
    // up on the next full navigation; not waiting 1.5s to learn about
    // it is a fine trade for a faster first interaction on the 99%
    // common path.
    const initiallyTerminal = job
      ? ["complete", "partial", "failed"].includes(job.status)
      : false
    if (!initiallyTerminal) {
      fetchJob()
      intervalRef.current = setInterval(fetchJob, POLL_INTERVAL_MS)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (simTimerRef.current) clearTimeout(simTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchJob])

  const visibleStatus = useVisibleStatus(job, simulatedStep !== null)

  // Derive render data BEFORE any conditional early return — the
  // useMemo below must not sit after a conditional `return`
  // (React's rules-of-hooks). Each of these is cheap to compute on
  // every render; only `validation` is memoised because regex-parsing
  // the full llms.txt every poll tick would be wasteful.
  //
  // Simulating → pass the raw status; live → clamp to visibleStatus
  // so fast transitions stay paced.
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
  const validation = useMemo(
    () => (result ? validateLlmsTxt(result) : null),
    [result],
  )

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

  return (
    <div className="h-screen font-sans bg-white flex flex-col">
      <AppHeader
        center={
          <>
            {/* Domain stays visible when the result is ready — users
                need to know which site's llms.txt they're looking at.
                During generation the mobile slot is tight (domain +
                "Generating…" + right-side buttons overflow), so the
                domain collapses below sm and the status pill takes
                its place. Divider stays as the brand/status separator.
                Page count + spec chip hide below sm; the mobile
                right side is tight enough already. */}
            <span className="h-4 w-px bg-zinc-200 shrink-0" aria-hidden />
            {(() => {
              const hideDomainOnMobile = !showResult && job && !isDone
              const domainClass = hideDomainOnMobile ? "hidden sm:block" : ""
              return domain
                ? <span className={`text-sm text-zinc-500 truncate ${domainClass}`}>{domain}</span>
                : <div className={`h-3 w-24 sm:w-32 bg-zinc-100 rounded animate-pulse ${domainClass}`} />
            })()}
            {showResult ? (
              <>
                <span className="text-zinc-300 hidden sm:block">·</span>
                <span className="text-xs text-zinc-400 font-mono hidden sm:block shrink-0">{crawledCount} pages</span>
                {validation && (
                  <span className={`hidden sm:flex items-center gap-1.5 ml-1 text-xs font-medium px-2.5 py-1 rounded-full ring-1 shrink-0 ${
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
              <>
                <span className="text-zinc-300 hidden sm:block">·</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400 shrink-0">
                  <Loader2 size={11} className="animate-spin" /> Generating…
                </span>
              </>
            ) : null}
          </>
        }
        right={
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Buttons stay visible on every viewport; labels collapse
                to icon-only below sm so the right side fits next to
                the logo + avatar without overlapping the center slot. */}
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
          <ResultPane job={job} signedIn={!!user} />
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

export default function PageView({
  initialJob,
  initialUser,
}: {
  initialJob: ApiJob | null
  initialUser: User | null
}) {
  return (
    <Suspense fallback={<PageViewFallback />}>
      <PageViewInner initialJob={initialJob} initialUser={initialUser} />
    </Suspense>
  )
}
