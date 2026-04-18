import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import SignOutButton from "./SignOutButton"
import JobActions from "./JobActions"
import { getUserPages } from "@/lib/store"

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
            <p className="text-sm text-zinc-500 mt-1">Pages you&apos;ve generated</p>
          </div>
          <Link
            href="/"
            className="flex items-center gap-1.5 bg-zinc-950 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            New page
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
                      {page.latestJobStatus && <StatusBadge status={page.latestJobStatus} />}
                    </div>
                    <p className="text-xs text-zinc-400 truncate">{page.pageUrl}</p>
                  </div>
                  <div className="flex items-center ml-4 shrink-0">
                    <div className="w-8 flex justify-center">
                      <JobActions pageUrl={page.pageUrl} />
                    </div>
                    <div className="text-right" style={{ width: "5.5rem" }}>
                      <span className="text-xs text-zinc-400">
                        {formatDistanceToNow(page.requestedAt, { addSuffix: true }).replace("less than a minute ago", "< 1 min ago")}
                      </span>
                    </div>
                    <div className="w-6 flex justify-end">
                      <span className="text-zinc-300 group-hover:text-zinc-500 transition-colors">→</span>
                    </div>
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
