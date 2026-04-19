import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { FolderDown } from "lucide-react"
import PageList, { type WirePage } from "./PageList"
import { getUserPages } from "@/lib/store"

// Force dynamic rendering — this page's content depends on whatever
// was just written to user_requests / jobs, and Next's client router
// cache would otherwise serve a stale RSC payload when navigating back
// from /p/[id].
export const dynamic = "force-dynamic"

const INITIAL_PAGE_SIZE = 20

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Fetch one extra so we can tell the client whether more pages exist.
  const raw = await getUserPages(user.id, { offset: 0, limit: INITIAL_PAGE_SIZE + 1 })
  const hasMore = raw.length > INITIAL_PAGE_SIZE
  const initial: WirePage[] = raw.slice(0, INITIAL_PAGE_SIZE).map((p) => ({
    ...p,
    requestedAt: p.requestedAt.toISOString(),
    lastCheckedAt: p.lastCheckedAt ? p.lastCheckedAt.toISOString() : null,
  }))

  return (
    <div className="min-h-screen bg-white font-sans">
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-950 tracking-tight">Dashboard</h1>
            <p className="text-sm text-zinc-500 mt-1">Your requested pages</p>
          </div>
          {initial.length > 0 && (
            <a
              href="/api/pages/download"
              download
              title="Download all your llms.txt files as a zip"
              className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 hover:text-zinc-900 px-3.5 py-2 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-colors"
            >
              <FolderDown size={14} className="text-zinc-400" />
              Download
            </a>
          )}
        </div>
        <PageList
          initialPages={initial}
          initialHasMore={hasMore}
          pageSize={INITIAL_PAGE_SIZE}
        />
      </main>
    </div>
  )
}
