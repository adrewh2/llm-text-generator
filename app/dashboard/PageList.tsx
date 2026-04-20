"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import JobActions from "./JobActions"
import MonitorStatus from "./MonitorStatus"

// Wire-serialized shape coming from the server / /api/pages — Dates
// are ISO strings across the JSON boundary.
export interface WirePage {
  pageUrl: string
  pageId: string | null
  siteName: string | null
  genre: string | null
  requestedAt: string
  latestJobStatus: string | null
  monitored: boolean
  lastCheckedAt: string | null
}

interface Props {
  initialPages: WirePage[]
  initialHasMore: boolean
  pageSize: number
}

export default function PageList({ initialPages, initialHasMore, pageSize }: Props) {
  const [pages, setPages] = useState<WirePage[]>(initialPages)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const fetchMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/pages?offset=${pages.length}&limit=${pageSize}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: { pages: WirePage[]; hasMore: boolean } = await res.json()
      // Dedupe by pageUrl on append. The dashboard is ordered by
      // created_at DESC, and `upsertUserRequest` bumps that timestamp
      // on re-submission — if the user re-asks about an already-loaded
      // URL in another tab between paginations, the offset-based fetch
      // can legitimately return a row we already have. Prefer the
      // already-displayed copy (older in the list) over a duplicate.
      setPages((prev) => {
        const seen = new Set(prev.map((p) => p.pageUrl))
        const fresh = data.pages.filter((p) => !seen.has(p.pageUrl))
        return [...prev, ...fresh]
      })
      setHasMore(data.hasMore)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more")
    } finally {
      setLoading(false)
    }
  }, [loading, hasMore, pages.length, pageSize])

  const removeLocal = useCallback((pageUrl: string) => {
    setPages((prev) => prev.filter((p) => p.pageUrl !== pageUrl))
  }, [])

  // Trigger fetch when sentinel scrolls into view. rootMargin starts
  // the load ~200px before the sentinel is visible so the next batch
  // is ready by the time the user reaches the bottom.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) fetchMore() },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [fetchMore, hasMore])

  // Live-refresh ONLY the rows whose latest job is still non-terminal
  // — hits /api/p/{id} once per running row instead of refetching the
  // whole paginated window on every tick. Merges by pageUrl. When a
  // row flips terminal we reuse the job's updatedAt for lastCheckedAt
  // (updateJob writes both at the same `now` — lib/store.ts#L137-148)
  // so MonitorStatus goes "Refreshing…" → "Refreshed just now"
  // immediately, instead of sitting on a stale timestamp until the
  // next monitor cron tick.
  const runningIdsKey = pages
    .filter(
      (p) => p.pageId !== null &&
        p.latestJobStatus !== null &&
        !["complete", "partial", "failed"].includes(p.latestJobStatus),
    )
    .map((p) => p.pageId)
    .join(",")
  useEffect(() => {
    if (!runningIdsKey) return
    const ids = runningIdsKey.split(",")
    let cancelled = false
    const tick = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await fetch(`/api/p/${id}`)
            if (!res.ok) return null
            return (await res.json()) as {
              url: string
              status: string
              siteName?: string
              genre?: string
              updatedAt: string
            }
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const byUrl = new Map<string, { url: string; status: string; siteName?: string; genre?: string; updatedAt: string }>()
      for (const r of results) {
        if (r) byUrl.set(r.url, r)
      }
      if (byUrl.size === 0) return
      setPages((prev) => prev.map((p) => {
        const job = byUrl.get(p.pageUrl)
        if (!job) return p
        const terminal = ["complete", "partial", "failed"].includes(job.status)
        return {
          ...p,
          siteName: job.siteName ?? p.siteName,
          genre: job.genre ?? p.genre,
          latestJobStatus: job.status,
          lastCheckedAt: terminal ? job.updatedAt : p.lastCheckedAt,
        }
      }))
    }
    tick()
    const intervalId = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(intervalId) }
  }, [runningIdsKey])

  if (pages.length === 0) {
    return (
      <div className="text-center py-24 border border-dashed border-zinc-200 rounded-2xl">
        <p className="text-zinc-400 text-[15px] mb-4">No pages yet</p>
        <Link href="/" className="text-[15px] font-medium text-zinc-900 underline underline-offset-2">
          Generate your first llms.txt
        </Link>
      </div>
    )
  }

  return (
    <>
      <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-2xl overflow-hidden">
        {pages.map((page) => {
          const href = page.pageId ? `/p/${page.pageId}` : "/"
          const hostname = (() => { try { return new URL(page.pageUrl).hostname } catch { return page.pageUrl } })()
          // A job is "running" when it exists but hasn't reached any
          // terminal state. That drives both the "Refreshing…" label
          // and the absence of a Failed badge (a re-crawl should clear
          // the prior failure indicator while it's still in flight).
          const running =
            page.latestJobStatus !== null &&
            !["complete", "partial", "failed"].includes(page.latestJobStatus)
          // The row is a positioned container so the Link covers the
          // entire clickable area (prefetch, right-click-open-new-tab,
          // middle-click all work) while the trash <button> sits as
          // an absolutely-positioned sibling. This avoids the invalid-
          // HTML footgun of nesting <button> inside <a>.
          return (
            <div key={page.pageUrl} className="relative group hover:bg-zinc-50 transition-colors">
              <Link
                href={href}
                className="flex items-center justify-between px-5 py-4"
                aria-label={`Open ${page.siteName || hostname}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 mb-0.5">
                    <span className="text-zinc-900 text-sm truncate">
                      {page.siteName || hostname}
                    </span>
                    {page.latestJobStatus === "failed" && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-red-50 text-red-600">
                        Failed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 truncate">{page.pageUrl}</p>
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <MonitorStatus
                    monitored={page.monitored}
                    lastCheckedAt={page.lastCheckedAt ? new Date(page.lastCheckedAt) : null}
                    running={running}
                  />
                  {/* Spacer reserves the width the trash button takes
                      so the chevron doesn't jump when it appears. */}
                  <span className="w-7" aria-hidden />
                  <span className="text-zinc-300 group-hover:text-zinc-500 transition-colors w-4 text-right">→</span>
                </div>
              </Link>
              <div className="absolute right-12 top-1/2 -translate-y-1/2">
                <JobActions pageUrl={page.pageUrl} onRemoved={removeLocal} />
              </div>
            </div>
          )
        })}
      </div>

      <div ref={sentinelRef} className="h-8 flex items-center justify-center mt-3">
        {loading && <Loader2 size={16} className="text-zinc-400 animate-spin" />}
        {error && !loading && (
          <button
            onClick={fetchMore}
            className="text-xs font-medium text-zinc-600 hover:text-zinc-900 underline underline-offset-2"
          >
            Retry loading more
          </button>
        )}
        {!hasMore && pages.length > pageSize && (
          <span className="text-xs text-zinc-300">— end of history —</span>
        )}
      </div>
    </>
  )
}
