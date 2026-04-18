"use client"

import { useState, useEffect, useRef, useCallback, Suspense } from "react"
import { useParams, useSearchParams } from "next/navigation"
import {
  CheckCircle2, Circle, Loader2, Copy, Download, Check, Link2,
  Shield, AlertCircle, XCircle, LayoutDashboard, Plus,
} from "lucide-react"
import Link from "next/link"
import type { CrawlJob, JobStatus } from "@/lib/crawler/types"
import { validateLlmsTxt } from "@/lib/crawler/validate"
import { createClient } from "@/lib/supabase/client"

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApiJob extends Omit<CrawlJob, "createdAt" | "updatedAt"> {
  createdAt: string
  updatedAt: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STEPS: Array<{ id: JobStatus | "done"; label: string }> = [
  { id: "crawling",   label: "Crawling pages" },
  { id: "enriching",  label: "Enriching with AI" },
  { id: "scoring",    label: "Scoring & classifying" },
  { id: "assembling", label: "Assembling file" },
  { id: "complete",   label: "Finalizing" },
]

// Simulated step durations (ms) for cached results
const SIM_STEP_DURATIONS = [1800, 1600, 1400, 1200]

// Minimum time each step stays visible during a live crawl, so fast
// backend transitions (scoring → assembling → complete in <100ms) are
// still readable. Doesn't slow down genuinely slow steps — it only
// caps how fast visibleStatus can catch up to the real job status.
const LIVE_MIN_STEP_DWELL_MS = 1200

const STATUS_PROGRESSION = [
  "pending", "crawling", "enriching", "scoring", "assembling", "complete",
] as const

// ─── Progress Pane ────────────────────────────────────────────────────────────

function ProgressPane({ job, simulatedStep }: { job: ApiJob; simulatedStep?: number }) {
  const domain = (() => { try { return new URL(job.url).hostname } catch { return job.url } })()
  const isSimulated = simulatedStep !== undefined

  const getStepStatus = (stepId: string) => {
    if (isSimulated) {
      const idx: Record<string, number> = { crawling: 0, enriching: 1, scoring: 2, assembling: 3, complete: 4 }
      const si = idx[stepId] ?? 0
      if (simulatedStep > si) return "done"
      if (simulatedStep === si) return "active"
      return "waiting"
    }
    if (job.status === "failed") return stepId === "crawling" ? "error" : "waiting"
    const order = ["pending", "crawling", "enriching", "scoring", "assembling", "complete", "partial"]
    const ji = order.indexOf(job.status)
    const si = ({ crawling: 1, enriching: 2, scoring: 3, assembling: 4, complete: 5 } as Record<string, number>)[stepId] ?? 0
    if (ji > si) return "done"
    if (ji === si) return "active"
    return "waiting"
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.12em] mb-2">Generating</p>
          <h2 className="text-xl font-semibold text-zinc-950 tracking-tight">Analyzing {domain}</h2>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm mb-4">
          {STEPS.map((step, idx) => {
            const status = getStepStatus(step.id)
            const isLast = idx === STEPS.length - 1
            return (
              <div key={step.id} className={`flex items-center gap-4 px-5 py-4 ${!isLast ? "border-b border-zinc-100" : ""}`}>
                <div className="shrink-0">
                  {status === "done"    && <CheckCircle2 size={18} className="text-emerald-500" />}
                  {status === "active"  && <Loader2 size={18} className="text-zinc-900 animate-spin" />}
                  {status === "waiting" && <Circle size={18} className="text-zinc-200" />}
                  {status === "error"   && <XCircle size={18} className="text-red-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${status === "waiting" ? "text-zinc-400" : "text-zinc-900"}`}>
                    {step.label}
                  </p>
                  {status === "active" && step.id === "crawling" && !isSimulated && (
                    <p className="text-xs text-zinc-500 mt-0.5">{job.progress.crawled} / 25 pages crawled</p>
                  )}
                </div>
                {status === "active" && (
                  <div className="flex gap-1 shrink-0">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="w-1 h-1 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {!isSimulated && job.status === "failed" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle size={14} className="text-red-500" />
              <p className="text-sm font-medium text-red-700">Crawl failed</p>
            </div>
            <p className="text-xs text-red-600">{job.error || "An unexpected error occurred."}</p>
          </div>
        )}

        <div className="bg-zinc-50 rounded-xl overflow-hidden border border-zinc-200">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-200">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-zinc-500 text-xs font-mono">
              {isSimulated
                ? `${domain} · retrieving cached result`
                : `${job.progress.discovered} URLs discovered · ${job.progress.crawled} crawled`}
            </span>
          </div>
          <div className="h-24 flex items-center justify-center p-4">
            <p className="text-zinc-400 text-xs font-mono">
              {isSimulated
                ? simulatedStep === 0 ? `Crawling ${domain}…`
                  : simulatedStep === 1 ? "Classifying pages with AI…"
                  : simulatedStep === 2 ? "Scoring and classifying pages…"
                  : "Assembling llms.txt…"
                : job.status === "pending"    ? "Starting crawl…"
                : job.status === "crawling"   ? `Crawling ${domain}…`
                : job.status === "enriching"  ? "Classifying pages with AI…"
                : job.status === "scoring"    ? "Scoring and classifying pages…"
                : job.status === "assembling" ? "Assembling llms.txt…"
                : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Result Pane ─────────────────────────────────────────────────────────────

function ResultPane({ job }: { job: ApiJob }) {
  const content = job.result ?? ""
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(window.location.href.split("?")[0])
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2000)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = "llms.txt"; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 shrink-0">
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Result</span>
        <span className="text-zinc-200">·</span>
        <span className="text-[10px] text-zinc-400 font-mono">llms.txt</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors"
          >
            {copiedLink ? <Check size={11} /> : <Link2 size={11} />}
            {copiedLink ? "Copied!" : "Copy link"}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 text-[11px] font-medium text-white bg-zinc-950 hover:bg-zinc-800 px-2.5 py-1 rounded-md transition-colors"
          >
            <Download size={11} /> Download
          </button>
        </div>
      </div>
      <textarea
        value={content}
        readOnly
        className="flex-1 p-6 font-mono text-sm leading-[1.75] text-zinc-800 bg-white resize-none outline-none"
        spellCheck={false}
      />
    </div>
  )
}

// Module-level cache — persists across remounts so navigation is flicker-free
const jobCache = new Map<string, ApiJob>()
let cachedSignedIn: boolean | null = null

// ─── Page ────────────────────────────────────────────────────────────────────

function PageViewInner() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const shouldSimulate = searchParams?.get("simulate") === "1"
  const pageId = params?.id
  const [job, setJob] = useState<ApiJob | null>(() => (pageId ? jobCache.get(pageId) ?? null : null))
  const [notFound, setNotFound] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState<boolean>(cachedSignedIn ?? false)
  // Start simulated progress at step 0 when the URL asks for it — otherwise
  // a cached job (already status=complete on first fetch) briefly paints the
  // result pane before the simulation timers get a chance to kick in.
  const [simulatedStep, setSimulatedStep] = useState<number | null>(shouldSimulate ? 0 : null)
  // Client-side display status for live crawls — advances at most one
  // step per LIVE_MIN_STEP_DWELL_MS so the later (usually fast) steps
  // are legible instead of flashing by.
  const [visibleStatus, setVisibleStatus] = useState<string>(() => job?.status ?? "pending")
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
      if (step > SIM_STEP_DURATIONS.length) {
        setSimulatedStep(null)
        return
      }
      setSimulatedStep(step) // step === SIM_STEP_DURATIONS.length shows "Complete" as active
      const delay = step < SIM_STEP_DURATIONS.length ? SIM_STEP_DURATIONS[step] : 3000
      simTimerRef.current = setTimeout(advance, delay)
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
      jobCache.set(pageId, data)
      setJob(data)

      const isDone = data.status === "complete" || data.status === "partial"
      const isFailed = data.status === "failed"

      if (isDone || isFailed) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        // Show simulation if explicitly requested (cached result) or on first live completion
        if (isDone && shouldSimulate && !simulationStarted.current) {
          simulationStarted.current = true
          startSimulation()
        }
      } else if (shouldSimulate && !simulationStarted.current) {
        // Job still running but the URL asked us to simulate — fall back to
        // real progress instead of freezing on step 0.
        setSimulatedStep(null)
      }
    } catch {}
  }, [pageId, startSimulation])

  useEffect(() => {
    fetchJob()
    intervalRef.current = setInterval(fetchJob, 1500)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (simTimerRef.current) clearTimeout(simTimerRef.current)
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    }
  }, [fetchJob])

  // Pace visibleStatus so the stepper can't advance faster than
  // LIVE_MIN_STEP_DWELL_MS per step. Simulation mode manages its own
  // timing via simulatedStep and bypasses this effect.
  useEffect(() => {
    if (!job || simulatedStep !== null) return

    // Fast-path failures — show the error state immediately.
    if (job.status === "failed") {
      setVisibleStatus("failed")
      return
    }

    // "partial" completes the pipeline just like "complete" — collapse it
    // into the "complete" step for progression purposes.
    const effectiveTarget = job.status === "partial" ? "complete" : job.status
    const targetIdx = STATUS_PROGRESSION.indexOf(effectiveTarget as typeof STATUS_PROGRESSION[number])
    const currentIdx = STATUS_PROGRESSION.indexOf(visibleStatus as typeof STATUS_PROGRESSION[number])

    if (targetIdx === -1 || currentIdx === -1) return
    if (targetIdx <= currentIdx) return

    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = setTimeout(() => {
      const next = STATUS_PROGRESSION[currentIdx + 1]
      // When catching up to "complete" and the backend already reported
      // "partial", surface the partial status so the badge shows.
      setVisibleStatus(next === "complete" && job.status === "partial" ? "partial" : next)
    }, LIVE_MIN_STEP_DWELL_MS)
  }, [job, visibleStatus, simulatedStep])

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

  // When a simulation is running, visibleStatus is irrelevant (the
  // simulated-step UI controls the view). Otherwise, clamp the job's
  // status to visibleStatus so fast live-crawl transitions are paced.
  const displayJob = job
    ? simulatedStep !== null
      ? job
      : { ...job, status: visibleStatus as ApiJob["status"] }
    : null
  const isDone = !!displayJob && (displayJob.status === "complete" || displayJob.status === "partial")
  const showResult = isDone && simulatedStep === null
  const domain = job ? (() => { try { return new URL(job.url).hostname } catch { return job.url } })() : ""
  const pages = job?.pages || []
  const crawledCount = pages.filter((p) => p.fetchStatus === "ok").length
  // Only validate once we have a non-empty result — otherwise a
  // half-propagated write (job.status=complete before pages.result lands)
  // would trip "missing H1" on empty text. The store now writes pages
  // first, so this is belt-and-suspenders.
  const validation = showResult && job!.result ? validateLlmsTxt(job!.result) : null

  return (
    <div className="h-screen font-sans bg-white flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-100 px-6 py-3 flex items-center gap-4 shrink-0">
        <Link href="/" className="flex items-center gap-2 mr-2 shrink-0">
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
              {displayJob!.status === "partial" && (
                <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 text-xs font-medium px-2 py-0.5 rounded-full ring-1 ring-amber-100 shrink-0">
                  <AlertCircle size={10} /> Partial
                </span>
              )}
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
          {showResult && isSignedIn && (
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 bg-zinc-50 hover:bg-zinc-100 px-3 py-1.5 rounded-lg border border-zinc-200 transition-all"
            >
              <LayoutDashboard size={12} /> Dashboard
            </Link>
          )}
        </div>
      </header>

      {/* Validation errors banner */}
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

      {/* Main content */}
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

export default function PageView() {
  return (
    <Suspense>
      <PageViewInner />
    </Suspense>
  )
}
