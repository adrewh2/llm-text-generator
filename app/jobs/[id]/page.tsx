"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useParams } from "next/navigation"
import {
  CheckCircle2, Circle, Loader2, Copy, Download, Check,
  Search, ChevronDown, Shield, AlertCircle, ExternalLink,
  RefreshCw, Filter, ArrowLeft, XCircle,
} from "lucide-react"
import Link from "next/link"
import type { CrawlJob, ScoredPage, JobStatus, PageType } from "@/lib/crawler/types"
import { validateLlmsTxt } from "@/lib/crawler/validate"

// ─── Types ──────────────────────────────────────────────────────────────────

interface ApiJob extends Omit<CrawlJob, "createdAt" | "updatedAt"> {
  createdAt: string
  updatedAt: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_TYPE_CONFIG: Record<PageType, { label: string; className: string }> = {
  doc:       { label: "Doc",       className: "bg-blue-50 text-blue-700 ring-blue-100" },
  example:   { label: "Example",   className: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  api:       { label: "API",       className: "bg-amber-50 text-amber-700 ring-amber-100" },
  blog:      { label: "Blog",      className: "bg-purple-50 text-purple-700 ring-purple-100" },
  changelog: { label: "Changelog", className: "bg-orange-50 text-orange-700 ring-orange-100" },
  about:     { label: "About",     className: "bg-slate-50 text-slate-600 ring-slate-100" },
  product:   { label: "Product",   className: "bg-pink-50 text-pink-700 ring-pink-100" },
  pricing:   { label: "Pricing",   className: "bg-indigo-50 text-indigo-700 ring-indigo-100" },
  support:   { label: "Support",   className: "bg-cyan-50 text-cyan-700 ring-cyan-100" },
  policy:    { label: "Policy",    className: "bg-zinc-50 text-zinc-500 ring-zinc-100" },
  program:   { label: "Program",   className: "bg-teal-50 text-teal-700 ring-teal-100" },
  news:      { label: "News",      className: "bg-yellow-50 text-yellow-700 ring-yellow-100" },
  project:   { label: "Project",   className: "bg-violet-50 text-violet-700 ring-violet-100" },
  other:     { label: "Other",     className: "bg-zinc-50 text-zinc-500 ring-zinc-100" },
}

const STEPS: Array<{ id: JobStatus | "done"; label: string }> = [
  { id: "crawling",   label: "Crawling pages" },
  { id: "scoring",    label: "Scoring & classifying" },
  { id: "assembling", label: "Assembling file" },
  { id: "complete",   label: "Complete" },
]

// ─── Sub-components ──────────────────────────────────────────────────────────

function PageTypeBadge({ type }: { type: PageType }) {
  const cfg = PAGE_TYPE_CONFIG[type]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ring-1 ${cfg.className}`}>
      {cfg.label}
    </span>
  )
}

// ─── Progress View ───────────────────────────────────────────────────────────

function ProgressView({ job }: { job: ApiJob }) {
  const feedRef = useRef<HTMLDivElement>(null)
  const domain = (() => { try { return new URL(job.url).hostname } catch { return job.url } })()

  const getStepStatus = (stepId: string) => {
    if (job.status === "failed") return stepId === "crawling" ? "error" : "waiting"
    const order = ["pending", "crawling", "scoring", "assembling", "complete", "partial"]
    const jobIdx = order.indexOf(job.status)
    const stepIdxMap: Record<string, number> = { crawling: 1, scoring: 2, assembling: 3, complete: 4 }
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
              {job.progress.failed > 0 && ` · ${job.progress.failed} failed`}
            </span>
          </div>
          <div ref={feedRef} className="h-32 flex items-center justify-center p-4">
            {job.status === "pending" ? (
              <p className="text-zinc-600 text-xs font-mono">Starting crawl…</p>
            ) : (
              <p className="text-zinc-600 text-xs font-mono">
                {job.status === "crawling"
                  ? `Crawling ${domain}…`
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
  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<PageType | "all">("all")
  const [showTypeMenu, setShowTypeMenu] = useState(false)

  const domain = (() => { try { return new URL(job.url).hostname } catch { return job.url } })()
  const pages = job.pages || []
  const validation = validateLlmsTxt(content)

  const filteredPages = pages.filter((p) => {
    if (p.fetchStatus !== "ok") return false
    const matchSearch = !searchQuery ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.url.toLowerCase().includes(searchQuery.toLowerCase())
    const matchType = typeFilter === "all" || p.pageType === typeFilter
    return matchSearch && matchType
  })

  const includedCount = pages.filter((p) => p.fetchStatus === "ok" && p.score >= 50).length

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
            {includedCount}/{pages.filter(p => p.fetchStatus === "ok").length} pages included
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

      {/* Two-panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: editor */}
        <div className="flex-[3] flex flex-col border-r border-zinc-100 overflow-hidden min-w-0">
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

        {/* Right: page explorer */}
        <div className="flex-[2] flex flex-col overflow-hidden min-w-0 max-w-sm">
          <div className="px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 shrink-0">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Pages</span>
              <div className="relative">
                <button
                  onClick={() => setShowTypeMenu(!showTypeMenu)}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-900 transition-colors font-medium"
                >
                  <Filter size={10} />
                  {typeFilter === "all" ? "All types" : PAGE_TYPE_CONFIG[typeFilter].label}
                  <ChevronDown size={10} />
                </button>
                {showTypeMenu && (
                  <div className="absolute right-0 top-6 bg-white border border-zinc-200 rounded-lg shadow-lg z-10 p-1 min-w-[120px]">
                    <button onClick={() => { setTypeFilter("all"); setShowTypeMenu(false) }}
                      className="w-full text-left text-xs px-2 py-1.5 hover:bg-zinc-50 rounded">All</button>
                    {(Object.keys(PAGE_TYPE_CONFIG) as PageType[]).map((t) => (
                      <button key={t} onClick={() => { setTypeFilter(t); setShowTypeMenu(false) }}
                        className="w-full text-left text-xs px-2 py-1.5 hover:bg-zinc-50 rounded">
                        {PAGE_TYPE_CONFIG[t].label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                placeholder="Search pages…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-7 pr-3 py-1.5 text-xs bg-white border border-zinc-200 rounded-lg outline-none focus:border-zinc-400 transition-colors placeholder-zinc-400"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredPages.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-zinc-400">No pages match</div>
            ) : (
              filteredPages.map((page) => {
                const isIncluded = page.score >= 50
                return (
                  <div
                    key={page.url}
                    className={`flex items-start gap-3 px-4 py-3 border-b border-zinc-50 group ${!isIncluded ? "opacity-50" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs font-medium text-zinc-900 truncate">{page.title}</span>
                        <PageTypeBadge type={page.pageType} />
                        {page.mdUrl && (
                          <span className="text-[9px] font-mono text-emerald-600 bg-emerald-50 px-1 rounded ring-1 ring-emerald-100">.md</span>
                        )}
                      </div>
                      {page.description && (
                        <p className="text-[10px] text-zinc-500 truncate leading-snug">{page.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-zinc-400 hover:text-zinc-600 font-mono truncate flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {page.url.replace(/^https?:\/\//, "").slice(0, 50)}
                          <ExternalLink size={9} />
                        </a>
                        <span className="text-[10px] text-zinc-300 ml-auto font-mono">score: {page.score}</span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="px-4 py-3 border-t border-zinc-100 shrink-0">
            <div className="text-[10px] text-zinc-400 text-center">
              {pages.filter(p => p.score >= 50).length} included · {pages.filter(p => p.score >= 30 && p.score < 50).length} optional · {pages.filter(p => p.score < 30).length} excluded
            </div>
          </div>
        </div>
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
