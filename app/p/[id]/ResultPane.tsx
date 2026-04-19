"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy, Download, Link2 } from "lucide-react"
import type { ApiJob } from "./types"

export default function ResultPane({ job }: { job: ApiJob }) {
  const content = job.result ?? ""
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear pending "Copied!" timers on unmount so they don't fire on
  // an unmounted component (React 19 no-ops this quietly but we'd
  // rather not rely on it).
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    if (copyLinkTimerRef.current) clearTimeout(copyLinkTimerRef.current)
  }, [])

  const handleCopyLink = async () => {
    // Build a clean shareable URL — same path, same hash, but drop
    // any query params (e.g. ?simulate=1 shouldn't travel).
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 shrink-0">
        {/* RESULT · llms.txt label group is purely contextual —
            collapse it on mobile so the three action buttons fit on
            one row without "Copy link" wrapping. */}
        <span className="hidden sm:inline text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">Result</span>
        <span className="hidden sm:inline text-zinc-200">·</span>
        <span className="hidden sm:inline text-[10px] text-zinc-400 font-mono">llms.txt</span>
        <div className="ml-auto flex items-center gap-2">
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
