import { notFound } from "next/navigation"
import { getPageById } from "@/lib/store"
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
  const job = await getPageById(id)
  if (!job) notFound()
  const initialJob: ApiJob = {
    ...job,
    error: job.error ? scrubError(job.error) : undefined,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
  return <PageView initialJob={initialJob} />
}
