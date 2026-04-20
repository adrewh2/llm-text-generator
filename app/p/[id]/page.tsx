import { notFound } from "next/navigation"
import { bumpPageRequest, getPageById } from "@/lib/store"
import { getCurrentUser } from "@/lib/supabase/getUser"
import PageView from "./PageView"
import { scrubError } from "@/app/api/p/[id]/scrubError"
import type { ApiJob } from "./types"

// Server-render the initial job state and hand it to the client
// component. Without this, every /p/{id} navigation painted an empty
// shell, then fetched /api/p/{id} from the client, then rendered —
// one extra round-trip of latency on every open. The client component
// still polls for live updates (progress, terminal flip), so the
// server payload is only the seed.
export default async function PageViewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [jobResult, user] = await Promise.all([
    getPageById(id),
    getCurrentUser(),
  ])
  if (!jobResult) notFound()

  // Record the navigation as user activity on the page. Critical for
  // cached-page views reached from the dashboard: once the result is
  // terminal, every subsequent `GET /api/p/[id]` is served from the
  // Vercel edge CDN and wouldn't reach our server — the client also
  // skips polling when SSR seeded a terminal job. Without bumping
  // here, an actively-read page looks dormant to the monitor sweeper,
  // which would unmonitor it after 5 days. Fire-and-forget: debounced
  // per Fluid instance, re-asserts `monitored = true` on the way.
  if (jobResult.status !== "failed") {
    bumpPageRequest(jobResult.url).catch(() => {})
  }

  const initialJob: ApiJob = {
    ...jobResult,
    error: jobResult.error ? scrubError(jobResult.error) : undefined,
    createdAt: jobResult.createdAt.toISOString(),
    updatedAt: jobResult.updatedAt.toISOString(),
  }
  return <PageView initialJob={initialJob} initialUser={user} />
}
