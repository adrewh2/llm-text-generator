import type { CrawlJob } from "./crawler/types"

// Attach to globalThis so the store persists across Next.js hot reloads and
// module re-evaluations, which would otherwise reset a module-level Map.
const g = globalThis as typeof globalThis & { __llmsTxtJobs?: Map<string, CrawlJob> }
if (!g.__llmsTxtJobs) g.__llmsTxtJobs = new Map()
const jobs = g.__llmsTxtJobs

export function createJob(id: string, url: string): CrawlJob {
  const job: CrawlJob = {
    id,
    url,
    status: "pending",
    progress: { discovered: 0, crawled: 0, failed: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): CrawlJob | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, updates: Partial<CrawlJob>): void {
  const existing = jobs.get(id)
  if (!existing) return
  jobs.set(id, { ...existing, ...updates, updatedAt: new Date() })
}
