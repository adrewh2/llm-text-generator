"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useParams } from "next/navigation"
import {
  CheckCircle2, Circle, Loader2, Copy, Download, Check,
  Shield, AlertCircle, ArrowLeft, XCircle,
} from "lucide-react"
import Link from "next/link"
import type { CrawlJob, JobStatus } from "@/lib/crawler/types"
import { validateLlmsTxt } from "@/lib/crawler/validate"

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
  { id: "complete",   label: "Complete" },
]

// ─── Progress View ───────────────────────────────────────────────────────────

function ProgressView({ job }: { job: ApiJob }) {
  const feedRef = useRef<HTMLDivElement>(null)
  const domain = (() => { try { return new URL(job.url).hostname } catch { return job.url } })()

  const getStepStatus = (stepId: string) => {
    if (job.status === "failed") return stepId === "crawling" ? "error" : "waiting"
    const order = ["pending", "crawling", "enriching", "scoring", "assembling", "complete", "partial"]
    const jobIdx = order.indexOf(job.status)
    const stepIdxMap: Record<string, number> = { crawling: 1, enriching: 2, scoring: 3, assembling: 4, complete: 5 }
    const stepIdx = stepIdxMap[stepId] ?? 0
    if (jobIdx > stepIdx) return "done"
    if (jobIdx === stepIdx) return "active"
    return "waiting"
  }

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [job.progress.crawled])

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-start pt-16 px-6">
      <div className="w-full max-w-xl">
        <div className="mb-2">
          <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-700 transition-colors">
            <ArrowLeft size={12} /> Back
          </Link>
        </div>
        <div className="mb-10 text-center">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.12em] mb-2">Generating</p>
          <h1 className="text-2xl font-display text-zinc-950 tracking-tight">Analyzing your website</h1>
          <p className="text-sm text-zinc-500 mt-2">{domain}</p>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm mb-6">
          {STEPS.map((step, idx) => {
            const status = getStepStatus(step.id)
            const isLast = idx === STEPS.length - 1
            return (
              <div key={step.id} className={`flex items-center gap-4 px-5 py-4 ${!isLast ? "border-b border-zinc-100" : ""}`}>
                <div className="shrink-0">
                  {status === "done" && <CheckCircle2 size={18} className="text-emerald-500" />}
                  {status === "active" && <Loader2 size={18} className="text-zinc-900 animate-spin" />}
                  {status === "waiting" && <Circle size={18} className="text-zinc-200" />}
                  {status === "error" && <XCircle size={18} className="text-red-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${status === "waiting" ? "text-zinc-400" : "text-zinc-900"}`}>
                    {step.label}
                  </p>
                  {status === "active" && step.id === "crawling" && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {job.progress.crawled} / {Math.min(job.progress.discovered, 25)} pages crawled
                    </p>
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

        {job.status === "failed" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle size={14} className="text-red-500" />
              <p className="text-sm font-medium text-red-700">Crawl failed</p>
            </div>
            <p className="text-xs text-red-600">{job.error || "An unexpected error occurred."}</p>
            <Link href="/" className="mt-3 inline-flex text-xs text-red-600 underline">
              Try another URL
            </Link>
          </div>
        )}

        <div className="bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-zinc-400 text-xs font-mono">
              {job.progress.discovered} URLs discovered · {job.progress.crawled} crawled
            </span>
          </div>
          <div ref={feedRef} className="h-32 flex items-center justify-center p-4">
            {job.status === "pending" ? (
              <p className="text-zinc-600 text-xs font-mono">Starting crawl…</p>
            ) : (
              <p className="text-zinc-600 text-xs font-mono">
                {job.status === "crawling"
                  ? `Crawling ${domain}…`
                  : job.status === "enriching"
                  ? "Classifying pages with AI…"
                  : job.status === "scoring"
                  ? "Scoring and classifying pages…"
                  : job.status === "assembling"
                  ? "Assembling llms.txt…"
                  : ""}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Result View ─────────────────────────────────────────────────────────────

function ResultView({ job }: { job: ApiJob }) {
  const [content, setContent] = useState(job.result || "")
  const [copied, setCopied] = useState(false)

  const domain = (() => { try { return new URL(job.url).hostname } catch { return job.url } })()
  const pages = job.pages || []
  const validation = validateLlmsTxt(content)
  const crawledCount = pages.filter((p) => p.fetchStatus === "ok").length

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "llms.txt"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-screen bg-white flex flex-col">
      {/* Top bar */}
      <header className="border-b border-zinc-100 px-6 py-3 flex items-center gap-4 shrink-0">
        <Link href="/" className="flex items-center gap-2 mr-2">
          <div className="w-5 h-5 bg-zinc-950 rounded-[4px] flex items-center justify-center">
            <span className="text-white font-mono text-[8px] font-bold">//</span>
          </div>
        </Link>
        <div className="h-4 w-px bg-zinc-200" />
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm text-zinc-500 hidden sm:block">{domain}</span>
          <span className="text-zinc-300 hidden sm:block">·</span>
          <span className="text-xs text-zinc-400 font-mono hidden sm:block">
            {crawledCount} pages crawled
          </span>
          {job.genre && (
            <span className="text-xs text-zinc-400 font-mono hidden md:block">· {job.genre.replace(/_/g, " ")}</span>
          )}
          {job.status === "partial" && (
            <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 text-xs font-medium px-2 py-0.5 rounded-full ring-1 ring-amber-100">
              <AlertCircle size={10} /> Partial
            </span>
          )}
          <button
            className={`flex items-center gap-1.5 ml-2 text-xs font-medium px-2.5 py-1 rounded-full ring-1 transition-colors ${
              validation.valid
                ? "bg-emerald-50 text-emerald-700 ring-emerald-100 hover:bg-emerald-100"
                : "bg-red-50 text-red-600 ring-red-100 hover:bg-red-100"
            }`}
          >
            <Shield size={11} />
            {validation.valid ? "Spec valid" : `${validation.errors.length} issue${validation.errors.length > 1 ? "s" : ""}`}
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 bg-zinc-50 hover:bg-zinc-100 px-3 py-1.5 rounded-lg border border-zinc-200 transition-all"
          >
            {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 text-xs font-medium text-white bg-zinc-950 hover:bg-zinc-800 px-3 py-1.5 rounded-lg transition-all active:scale-95"
          >
            <Download size={12} />
            Download
          </button>
        </div>
      </header>

      {/* Validation errors (if any) */}
      {!validation.valid && (
        <div className="bg-red-50 border-b border-red-100 px-6 py-2">
          <ul className="text-xs text-red-600 space-y-0.5">
            {validation.errors.slice(0, 3).map((e, i) => (
              <li key={i}>{e.line ? `Line ${e.line}: ` : ""}{e.message}</li>
            ))}
            {validation.errors.length > 3 && (
              <li className="text-red-400">+{validation.errors.length - 3} more issues</li>
            )}
          </ul>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 shrink-0">
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Editor</span>
          <span className="text-zinc-200">·</span>
          <span className="text-[10px] text-zinc-400 font-mono">llms.txt</span>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 p-6 font-mono text-sm leading-[1.75] text-zinc-800 bg-white resize-none outline-none"
          spellCheck={false}
        />
      </div>
    </div>
  )
}

// ─── Page orchestrator ───────────────────────────────────────────────────────

export default function JobPage() {
  const params = useParams<{ id: string }>()
  const jobId = params?.id
  const [job, setJob] = useState<ApiJob | null>(null)
  const [notFound, setNotFound] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchJob = useCallback(async () => {
    if (!jobId) return
    try {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (res.status === 404) { setNotFound(true); return }
      if (!res.ok) return
      const data: ApiJob = await res.json()
      setJob(data)

      if (data.status === "complete" || data.status === "failed" || data.status === "partial") {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    } catch {}
  }, [jobId])

  useEffect(() => {
    fetchJob()
    intervalRef.current = setInterval(fetchJob, 1500)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [fetchJob])

  if (notFound) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 mb-4">Job not found.</p>
          <Link href="/" className="text-sm text-zinc-900 underline">Start a new crawl</Link>
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Loader2 size={24} className="text-zinc-400 animate-spin" />
      </div>
    )
  }

  const isDone = job.status === "complete" || job.status === "partial"

  return (
    <div className="font-sans">
      {isDone && job.result ? (
        <ResultView job={job} />
      ) : (
        <ProgressView job={job} />
      )}
    </div>
  )
}
