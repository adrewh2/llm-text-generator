"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import { Check, Copy, Download, Link2, RefreshCw, Save } from "lucide-react"
import { crawler, ui } from "@/lib/config"
import type { ApiJob } from "./types"

const STALE_AFTER_MS = crawler.PAGE_TTL_HOURS * 60 * 60 * 1000

interface Props {
  job: ApiJob
  /** Whether the current viewer is signed in — gates the "Add to dashboard" button. */
  signedIn: boolean
}

export default function ResultPane({ job, signedIn }: Props) {
  const router = useRouter()
  const content = job.result ?? ""
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  // Tri-state for the dashboard-membership check:
  //   null    = not yet resolved (don't render the button — avoids flash)
  //   false   = checked, not in history → show button
  //   true    = already in history → hide button
  const [inHistory, setInHistory] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Freshness derived from the last time the monitor cron (or a fresh
  // crawl) stamped the page. Matches the "Refreshed X ago" label on the
  // dashboard. `isStale` mirrors `PAGE_TTL_HOURS` — same threshold that
  // the POST /api/p path uses to decide whether a submission triggers
  // a re-crawl, so the button's visibility is consistent with the
  // underlying cache-staleness rule.
  //
  // useMemo keeps the Date reference stable across renders so the
  // `[lastCheckedAt]` dep below doesn't tear down + restart the tick
  // interval on every render (which it would, since `new Date(...)`
  // returns a fresh reference every call).
  const lastCheckedAt = useMemo(
    () => (job.lastCheckedAt ? new Date(job.lastCheckedAt) : null),
    [job.lastCheckedAt],
  )
  const isStale = lastCheckedAt
    ? Date.now() - lastCheckedAt.getTime() >= STALE_AFTER_MS
    : false

  // `formatDistanceToNowStrict(lastCheckedAt)` is a moving target: SSR
  // captures one interval, hydration captures another a few seconds
  // later, mismatch fails the hydration check. Mount-gate the relative
  // string so SSR + first client paint render the same placeholder
  // ("Refreshed"), then swap to the live string after mount.
  const [mounted, setMounted] = useState(false)
  // Tick state forces a re-render on an interval so formatDistanceToNowStrict
  // re-evaluates against the fresh clock — "35 seconds ago" → "1 minute ago"
  // without needing a page refresh. Matches the dashboard MonitorStatus
  // cadence (`ui.MONITOR_STATUS_TICK_MS`).
  const [, setTick] = useState(0)
  useEffect(() => {
    setMounted(true)
    if (!lastCheckedAt) return
    const id = setInterval(() => setTick((n) => n + 1), ui.MONITOR_STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [lastCheckedAt])

  // Clear pending "Copied!" timers on unmount so they don't fire on
  // an unmounted component (React 19 no-ops this quietly, but no
  // reason to rely on that).
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    if (copyLinkTimerRef.current) clearTimeout(copyLinkTimerRef.current)
  }, [])

  // Resolve dashboard membership once per (viewer, url). Anon users
  // skip the round-trip entirely — inHistory stays null and the
  // button never renders. If the fetch fails (network, 500), treat
  // as "already in" so the user isn't prompted to save something
  // when membership is uncertain.
  useEffect(() => {
    if (!signedIn || !job.url) {
      setInHistory(null)
      return
    }
    let cancelled = false
    fetch(`/api/p/request?pageUrl=${encodeURIComponent(job.url)}`)
      .then((res) => res.ok ? res.json() : { inHistory: true })
      .then((data: { inHistory?: boolean }) => {
        if (!cancelled) setInHistory(data.inHistory === true)
      })
      .catch(() => {
        if (!cancelled) setInHistory(true)
      })
    return () => { cancelled = true }
  }, [signedIn, job.url])

  const handleCopyLink = async () => {
    // Build a clean shareable URL — same path, same hash, drop any
    // query params so they don't travel.
    const loc = new URL(window.location.href)
    loc.search = ""
    await navigator.clipboard.writeText(loc.toString())
    setCopiedLink(true)
    if (copyLinkTimerRef.current) clearTimeout(copyLinkTimerRef.current)
    copyLinkTimerRef.current = setTimeout(() => setCopiedLink(false), 2000)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = "llms.txt"; a.click()
    URL.revokeObjectURL(url)
  }

  const handleAddToDashboard = async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/p/request?pageUrl=${encodeURIComponent(job.url)}`, {
        method: "POST",
      })
      if (res.ok) setInHistory(true)
    } finally {
      setSaving(false)
    }
  }

  const handleRefresh = async () => {
    if (submitting) return
    setSubmitting(true)
    setRefreshError(null)
    // Same endpoint the landing-page Generate button uses. Server
    // returns either:
    //   - cached: true   → no new crawl. Soft-refresh the RSC so
    //                      the freshness label picks up the new
    //                      lastCheckedAt that the signature check
    //                      may have just bumped.
    //   - cached: false  → a crawl is in flight (new or attached).
    //                      Navigate to /jobs/{job_id}; that page
    //                      polls and redirects back to /p/{id} on
    //                      completion.
    let res: Response
    try {
      res = await fetch("/api/p", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: job.url }),
      })
    } catch {
      setRefreshError("Network error")
      setSubmitting(false)
      return
    }
    const data = (await res.json().catch(() => ({}))) as {
      page_id?: string
      job_id?: string
      cached?: boolean
      error?: string
    }
    if (!res.ok) {
      setRefreshError(typeof data.error === "string" ? data.error : "Failed to refresh")
      setSubmitting(false)
      return
    }
    if (data.cached === false && data.job_id) {
      // Navigation will unmount this component — leave `submitting`
      // true so the button stays "Refreshing…" through the hand-off
      // instead of flashing back to "Refresh" between router.push
      // and the route transition.
      router.push(`/jobs/${data.job_id}`)
      return
    }
    router.refresh()
    setSubmitting(false)
  }

  // Clear the refresh error after a few seconds so a transient failure
  // doesn't linger indefinitely.
  useEffect(() => {
    if (!refreshError) return
    const t = setTimeout(() => setRefreshError(null), 4000)
    return () => clearTimeout(t)
  }, [refreshError])

  // Only show the save button when:
  //   - the viewer is signed in,
  //   - the membership check has resolved,
  //   - the URL isn't already in their history.
  const showSave = signedIn && inHistory === false

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 shrink-0">
        {/* RESULT · llms.txt label group is purely contextual —
            collapse it on mobile so the action buttons fit on
            one row without wrapping. */}
        <span className="hidden sm:inline text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Result</span>
        <span className="hidden sm:inline text-zinc-200">·</span>
        <span className="hidden sm:inline text-[10px] text-zinc-400 font-mono">llms.txt</span>
        {/* Freshness label — desktop only. Tells viewers how current
            the displayed content is; complements the Refresh button
            below by making "why would I refresh?" self-evident. */}
        {lastCheckedAt && (
          <>
            <span className="hidden sm:inline text-zinc-200">·</span>
            <span
              className="hidden sm:inline text-[10px] text-zinc-400"
              // toLocaleString() is locale-dependent and can render
              // differently server-side (Node defaults to en-US) vs
              // client-side (browser locale), so only set the title
              // attribute after mount to avoid a hydration mismatch
              // on the attribute value.
              title={mounted ? lastCheckedAt.toLocaleString() : undefined}
            >
              Refreshed{mounted ? ` ${formatDistanceToNowStrict(lastCheckedAt, { addSuffix: true })}` : ""}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Transient refresh error — dismisses itself after ~4s.
              Rate-limit denials (429) and network errors both land here. */}
          {refreshError && (
            <span className="hidden sm:inline text-[11px] text-red-600" role="alert">
              {refreshError}
            </span>
          )}
          {/* Refresh button — desktop only, only when the cache is
              older than PAGE_TTL_HOURS. Clicking re-submits via
              POST /api/p; if a fresh crawl is dispatched, navigation
              hands off to /jobs/{job_id}. */}
          {/* Mount-gate so the SSR pass and the client first paint
              agree on whether to render the button — `isStale` reads
              `Date.now()`, which differs between server and client by
              the network-transit delay and would flip the boolean if
              `lastCheckedAt` sits near the staleness threshold. */}
          {mounted && isStale && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={submitting}
              aria-label="Refresh"
              title="Refresh"
              className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={submitting ? "animate-spin" : ""} />
              {submitting ? "Refreshing…" : "Refresh"}
            </button>
          )}
          {showSave && (
            <button
              type="button"
              onClick={handleAddToDashboard}
              disabled={saving}
              aria-label="Add to dashboard"
              title="Add to dashboard"
              className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors disabled:opacity-50"
            >
              <Save size={11} />
              <span className="hidden sm:inline">Add to Dashboard</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors"
          >
            {copiedLink ? <Check size={11} /> : <Link2 size={11} />}
            {copiedLink ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 hover:border-zinc-300 transition-colors"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
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
