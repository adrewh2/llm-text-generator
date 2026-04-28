import { notFound, redirect } from "next/navigation"
import { bumpPageRequest, getActiveJobForPage, getPageById } from "@/lib/store"
import { getCurrentUser } from "@/lib/supabase/getUser"
import PageView from "./PageView"
import { scrubError } from "@/app/api/p/[id]/scrubError"
import type { ApiJob } from "./types"

// /p/{id} is a stable cached-result permalink. It only ever renders
// the most-recently-good llms.txt for this page. Live progress lives
// at /jobs/{jobId}; landing-form submissions and Refresh clicks that
// dispatch a fresh crawl route there directly.
//
// Three landing states:
//   - cached result exists  → render ResultPane.
//   - no result, active job → redirect to /jobs/{jobId}.
//   - no result, no job     → 404 (e.g. only ever-failed crawls).
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

  if (!jobResult.result || jobResult.result.trim().length === 0) {
    const active = await getActiveJobForPage(id)
    if (active) redirect(`/jobs/${active.jobId}`)
    notFound()
  }

  // Record the navigation as user activity. Once a result is terminal,
  // subsequent GET /api/p/[id] polls are edge-cached and never reach
  // the server, so without bumping here an actively-read page would
  // look dormant and age out of the monitor rotation.
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
  // Key on lastCheckedAt so a no-drift Refresh (which only bumps the
  // freshness stamp) re-seeds PageView's lazy state with the fresh value.
  return (
    <PageView
      key={initialJob.lastCheckedAt ?? initialJob.updatedAt}
      initialJob={initialJob}
      initialUser={user}
    />
  )
}
