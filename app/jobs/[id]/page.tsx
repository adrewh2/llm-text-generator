import { notFound, redirect } from "next/navigation"
import { getJobById } from "@/lib/store"
import { getCurrentUser } from "@/lib/supabase/getUser"
import { scrubError } from "@/app/api/p/[id]/scrubError"
import JobView from "./JobView"

// Live-progress view for a single crawl job. Cache-miss submissions
// (POST /api/p with cached: false) and Refresh clicks that dispatch
// a fresh crawl land here. When the job goes terminal, JobView's
// poll handler redirects to /p/{pageId}.
//
// If the RSC catches a terminal job on first paint (someone shared
// or refreshed a /jobs/{id} link after completion), redirect server-
// side so we don't bother rendering the progress UI at all.
export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [job, user] = await Promise.all([getJobById(id), getCurrentUser()])
  if (!job) notFound()

  const isTerminalSuccess = job.status === "complete" || job.status === "partial"
  if (isTerminalSuccess) redirect(`/p/${job.pageId}`)

  return (
    <JobView
      initialJob={{
        id: job.jobId,
        pageId: job.pageId,
        pageUrl: job.pageUrl,
        status: job.status,
        progress: job.progress,
        error: job.error ? scrubError(job.error) : null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      }}
      initialUser={user}
    />
  )
}
