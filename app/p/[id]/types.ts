import type { CrawlJob } from "@/lib/crawler/types"

// Over the JSON boundary the Date fields on CrawlJob are ISO strings.
export interface ApiJob extends Omit<CrawlJob, "createdAt" | "updatedAt" | "lastCheckedAt"> {
  createdAt: string
  updatedAt: string
  lastCheckedAt?: string
}
