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

  // Record the navigation as user activity. Once a result is terminal,
  // subsequent GET /api/p/[id] polls are edge-cached and never reach
  // the server, so without bumping here an actively-read page would
  // look dormant and age out of the monitor rotation after 5 days.
  // Failed pages are skipped on purpose — we want them to age out.
  if (jobResult.status !== "failed") {
    bumpPageRequest(jobResult.url).catch(() => {})
  }

  const initialJob: ApiJob = {
    ...jobResult,
    error: jobResult.error ? scrubError(jobResult.error) : undefined,
    createdAt: jobResult.createdAt.toISOString(),
    updatedAt: jobResult.updatedAt.toISOString(),
    lastCheckedAt: jobResult.lastCheckedAt?.toISOString(),
  }
  // Key on updatedAt so a server-side Refresh (which creates a new job
  // and re-renders this RSC via router.refresh) causes PageView to
  // remount with the new initial state — otherwise its useState lazy
  // init holds the pre-refresh terminal job and polling never starts.
  return <PageView key={initialJob.updatedAt} initialJob={initialJob} initialUser={user} />
}
