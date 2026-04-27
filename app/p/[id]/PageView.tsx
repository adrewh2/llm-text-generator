"use client"

import { useEffect, useMemo, useState } from "react"
import { LayoutDashboard, Plus, Shield } from "lucide-react"
import Link from "next/link"
import type { User } from "@supabase/supabase-js"
import { validateLlmsTxt } from "@/lib/crawler/output/validate"
import { createClient } from "@/lib/supabase/client"
import AppHeader, { HEADER_BUTTON_CLASS } from "@/app/components/AppHeader"
import UserMenu from "@/app/components/UserMenu"
import ResultPane from "./ResultPane"
import type { ApiJob } from "./types"

// /p/{id} is a stable cached-result view. The RSC guarantees
// `initialJob.result` is always non-empty here (otherwise it would
// have redirected to /jobs/{jobId} or 404'd).
export default function PageView({
  initialJob,
  initialUser,
}: {
  initialJob: ApiJob
  initialUser: User | null
}) {
  const [user, setUser] = useState<User | null>(initialUser)

  // Track auth state for the lifetime of this page so the avatar +
  // Dashboard button stay accurate across sign-in / sign-out events
  // in another tab. INITIAL_SESSION fires synchronously with whatever
  // the client can resolve from cookies at that instant — trust the
  // server-resolved initialUser instead until a real auth event.
  useEffect(() => {
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const domain = hostnameOf(initialJob.url)
  const crawledCount = (initialJob.pages ?? []).filter((p) => p.fetchStatus === "ok").length
  const validation = useMemo(
    () => (initialJob.result ? validateLlmsTxt(initialJob.result) : null),
    [initialJob.result],
  )

  return (
    <div className="h-dvh font-sans bg-white flex flex-col">
      <AppHeader
        center={
          <>
            <span className="h-4 w-px bg-zinc-200 shrink-0" aria-hidden />
            <span className="text-sm text-zinc-500 truncate">{domain}</span>
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
        }
        right={
          <div className="flex items-center gap-2 sm:gap-3">
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

      <div className="flex-1 flex overflow-hidden">
        <ResultPane job={initialJob} signedIn={!!user} />
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}
