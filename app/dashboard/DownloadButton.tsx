"use client"

import { useEffect, useState } from "react"
import { FolderDown, Loader2 } from "lucide-react"
import ConfirmDialog from "@/app/components/ConfirmDialog"

// Client-side download orchestration. Using a plain <a download>
// here was a trap: on a 429 the browser happily wrote the JSON
// error body to disk as "download.json" with no feedback to the
// user. We now fetch the endpoint, check the status, and either
// stream the Blob into a temporary <a> or surface the server's
// error message inline.
export default function DownloadButton() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fadingOut, setFadingOut] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Auto-dismiss an error after ~10s. Fade the opacity first so the
  // notice doesn't vanish abruptly, then null the state after the
  // transition finishes. Every new error resets both timers so a
  // fresh message always gets the full dwell before it's cleared.
  useEffect(() => {
    if (!error) return
    setFadingOut(false)
    const fadeTimer = setTimeout(() => setFadingOut(true), 10_000)
    const clearTimer = setTimeout(() => setError(null), 10_500)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }
  }, [error])

  const formatRetry = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.ceil(seconds / 60)
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`
    const hrs = Math.ceil(mins / 60)
    return `${hrs} hour${hrs === 1 ? "" : "s"}`
  }

  const runDownload = async () => {
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const res = await fetch("/api/pages/download")
      if (res.status === 429) {
        // Server returns JSON { error, retryAfterSec } on 429.
        let retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10)
        try {
          const body = (await res.json()) as { retryAfterSec?: number }
          if (typeof body.retryAfterSec === "number") retryAfter = body.retryAfterSec
        } catch {
          // body might not be JSON; fall back to header only
        }
        const wait = retryAfter > 0 ? formatRetry(retryAfter) : "a while"
        setError(`Download limit reached — try again in ${wait}.`)
        return
      }
      if (!res.ok) {
        let msg = "Download failed. Try again."
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error) msg = body.error
        } catch {}
        setError(msg)
        return
      }

      const blob = await res.blob()
      // Pull the filename out of Content-Disposition if the server
      // provided one; fall back to a sensible default otherwise.
      const cd = res.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="?([^";]+)"?/)
      const filename = match?.[1] ?? `llms-txt-${new Date().toISOString().slice(0, 10)}.zip`
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError("Network error. Try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !loading && setConfirmOpen(true)}
        disabled={loading}
        title="Download all your llms.txt files as a zip"
        className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 px-3.5 py-2 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <Loader2 size={14} className="text-zinc-400 animate-spin" />
        ) : (
          <FolderDown size={14} className="text-zinc-400" />
        )}
        Download
      </button>
      {error && (
        // Absolutely positioned under the button so an inline error
        // doesn't push the title row (or anything else) down as it
        // appears / fades. whitespace-nowrap keeps the message on one
        // line even when it runs wider than the button.
        <p
          role="alert"
          className={`absolute right-0 top-full mt-1.5 text-xs text-red-500 whitespace-nowrap transition-opacity duration-500 ${fadingOut ? "opacity-0" : "opacity-100"}`}
        >
          {error}
        </p>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="Download your history?"
          body="The zip will include up to 500 of your most recently requested pages (one .txt per page)."
          note="Limited to 1 download every 24 hours."
          confirmLabel="Download"
          confirmVariant="primary"
          onConfirm={() => {
            setConfirmOpen(false)
            void runDownload()
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
