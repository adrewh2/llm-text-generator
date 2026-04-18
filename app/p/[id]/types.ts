import type { CrawlJob } from "@/lib/crawler/types"

// Over the JSON boundary the two Date fields on CrawlJob are ISO strings.
export interface ApiJob extends Omit<CrawlJob, "createdAt" | "updatedAt"> {
  createdAt: string
  updatedAt: string
}
