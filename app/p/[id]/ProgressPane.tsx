"use client"

import Link from "next/link"
import { AlertCircle, CheckCircle2, Circle, Loader2, Plus, XCircle } from "lucide-react"
import type { JobStatus } from "@/lib/crawler/types"
import { crawler } from "@/lib/config"
import type { ApiJob } from "./types"

const { MAX_PAGES } = crawler

const STEPS: Array<{ id: JobStatus; label: string }> = [
  { id: "crawling",   label: "Crawling pages" },
  { id: "enriching",  label: "Enriching with AI" },
  { id: "scoring",    label: "Scoring & classifying" },
  { id: "assembling", label: "Assembling file" },
]

// Step index by id — used by both simulated and live resolvers below.
const SIM_IDX: Record<string, number> = {
  crawling: 0, enriching: 1, scoring: 2, assembling: 3,
}
const LIVE_STEP_IDX: Record<string, number> = {
  crawling: 1, enriching: 2, scoring: 3, assembling: 4,
}
const LIVE_STATUS_ORDER = [
  "pending", "crawling", "enriching", "scoring", "assembling", "complete", "partial",
]

type StepState = "done" | "active" | "waiting" | "error"

export default function ProgressPane({
  job,
  simulatedStep,
}: {
  job: ApiJob
  simulatedStep?: number
}) {
  const domain = hostnameOf(job.url)
  const isSimulated = simulatedStep !== undefined

  const stateFor = (stepId: string): StepState => {
    if (isSimulated) {
      const si = SIM_IDX[stepId] ?? 0
      if (simulatedStep > si) return "done"
      if (simulatedStep === si) return "active"
      return "waiting"
    }
    if (job.status === "failed") return stepId === "crawling" ? "error" : "waiting"
    const ji = LIVE_STATUS_ORDER.indexOf(job.status)
    const si = LIVE_STEP_IDX[stepId] ?? 0
    if (ji > si) return "done"
    if (ji === si) return "active"
    return "waiting"
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-sm font-medium text-zinc-500 mb-2">
            Generating llms.txt for
          </p>
          <h2 className="text-xl font-semibold text-zinc-950 tracking-tight">
            {domain}
          </h2>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden shadow-sm mb-4">
          {STEPS.map((step, idx) => {
            const state = stateFor(step.id)
            const isLast = idx === STEPS.length - 1
            return (
              <div key={step.id} className={`flex items-center gap-4 px-5 py-4 ${!isLast ? "border-b border-zinc-100" : ""}`}>
                <div className="shrink-0">
                  {state === "done"    && <CheckCircle2 size={18} className="text-emerald-500" />}
                  {state === "active"  && <Loader2 size={18} className="text-zinc-900 animate-spin" />}
                  {state === "waiting" && <Circle size={18} className="text-zinc-200" />}
                  {state === "error"   && <XCircle size={18} className="text-red-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${state === "waiting" ? "text-zinc-400" : "text-zinc-900"}`}>
                    {step.label}
                  </p>
                  {state === "active" && step.id === "crawling" && !isSimulated && (
                    <p className="text-xs text-zinc-500 mt-0.5">{job.progress.crawled} / {MAX_PAGES} pages crawled</p>
                  )}
                </div>
                {state === "active" && (
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

        {!isSimulated && job.status === "failed" ? (
          <div className="bg-zinc-50 rounded-xl border border-zinc-200 p-5 flex flex-col items-center gap-3">
            <p className="text-xs text-zinc-500 text-center">
              Try a different site — most public sites crawl cleanly.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 px-3.5 py-2 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-white transition-colors"
            >
              <Plus size={14} className="text-zinc-400" />
              Try another URL
            </Link>
          </div>
        ) : (
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
                {bottomLabel(job, simulatedStep, domain)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function bottomLabel(job: ApiJob, simulatedStep: number | undefined, domain: string): string {
  if (simulatedStep !== undefined) {
    if (simulatedStep === 0) return `Crawling ${domain}…`
    if (simulatedStep === 1) return "Summarizing pages with AI…"
    if (simulatedStep === 2) return "Scoring and ranking pages…"
    return "Assembling llms.txt…"
  }
  switch (job.status) {
    case "pending":    return "Starting crawl…"
    case "crawling":
      // The browser path routes every fetch through a single Chromium
      // instance and renders pages one at a time — worth calling out
      // so the extra latency isn't mistaken for a stall.
      return job.progress.mode === "browser"
        ? `Crawling ${domain} with Chromium — one page at a time…`
        : `Crawling ${domain}…`
    case "enriching":  return "Summarizing pages with AI…"
    case "scoring":    return "Scoring and ranking pages…"
    case "assembling": return "Assembling llms.txt…"
    default:           return ""
  }
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
