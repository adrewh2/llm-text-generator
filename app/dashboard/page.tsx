import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Plus } from "lucide-react"
import SignOutButton from "./SignOutButton"
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
    <div className="min-h-screen bg-white">
      {/* Fixed header (not sticky) so the position is truly locked and
          can't sub-pixel-bounce as the content scrolls beneath it. */}
      <header className="fixed top-0 inset-x-0 z-50 bg-white border-b border-zinc-100">
        <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between border-b border-zinc-100">
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
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
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
      </header>

      {/* Spacer reserves the exact vertical space the fixed header takes
          (nav 56 + border 1 + title row 96 + border 1 ≈ 154px). Keep in
          sync if the header's padding/typography changes. */}
      <div aria-hidden className="h-[154px]" />

      <main className="max-w-4xl mx-auto px-6 py-8">
        <PageList
          initialPages={initial}
          initialHasMore={hasMore}
          pageSize={INITIAL_PAGE_SIZE}
        />
      </main>
    </div>
  )
}
