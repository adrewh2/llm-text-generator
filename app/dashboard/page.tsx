import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Plus } from "lucide-react"
import SignOutButton from "./SignOutButton"
import JobActions from "./JobActions"
import MonitorStatus from "./MonitorStatus"
import { getUserPages } from "@/lib/store"

// Force dynamic rendering — this page's content depends on whatever
// was just written to user_requests / jobs, and Next's client router
// cache would otherwise serve a stale RSC payload when navigating back
// from /p/[id].
export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const pages = await getUserPages(user.id)

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-zinc-100">
        <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-zinc-950 rounded-[5px] flex items-center justify-center shrink-0">
              <span className="text-white font-mono text-[9px] font-bold leading-none">//</span>
            </div>
            <span className="font-semibold text-zinc-950 text-sm tracking-tight">llms.txt</span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-xs text-zinc-400 hidden sm:block">{user.email}</span>
            <SignOutButton />
          </div>
        </nav>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-950 tracking-tight">Dashboard</h1>
            <p className="text-sm text-zinc-500 mt-1">Your requested pages</p>
          </div>
          <Link
            href="/?focus=1"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 px-3.5 py-2 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-colors"
          >
            <Plus size={14} className="text-zinc-400" />
            Generate
          </Link>
        </div>

        {pages.length === 0 ? (
          <div className="text-center py-24 border border-dashed border-zinc-200 rounded-2xl">
            <p className="text-zinc-400 text-sm mb-4">No pages yet</p>
            <Link href="/" className="text-sm font-medium text-zinc-900 underline underline-offset-2">
              Generate your first llms.txt
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-2xl overflow-hidden">
            {pages.map((page) => {
              const href = page.latestJobId ? `/p/${page.latestJobId}` : "/"
              const hostname = (() => { try { return new URL(page.pageUrl).hostname } catch { return page.pageUrl } })()
              return (
                <Link
                  key={page.pageUrl}
                  href={href}
                  className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50 transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 mb-0.5">
                      <span className="font-medium text-zinc-900 text-sm truncate">
                        {page.siteName || hostname}
                      </span>
                      {page.latestJobStatus === "failed" && (
                        <StatusBadge status={page.latestJobStatus} />
                      )}
                    </div>
                    <p className="text-xs text-zinc-400 truncate">{page.pageUrl}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    <MonitorStatus monitored={page.monitored} lastCheckedAt={page.lastCheckedAt} />
                    <JobActions pageUrl={page.pageUrl} />
                    <span className="text-zinc-300 group-hover:text-zinc-500 transition-colors w-4 text-right">→</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    complete:   { label: "Complete",  className: "bg-emerald-50 text-emerald-700" },
    partial:    { label: "Partial",   className: "bg-amber-50 text-amber-700" },
    failed:     { label: "Failed",    className: "bg-red-50 text-red-600" },
  }
  const s = map[status] ?? { label: status, className: "bg-zinc-100 text-zinc-500" }
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${s.className}`}>
      {s.label}
    </span>
  )
}
