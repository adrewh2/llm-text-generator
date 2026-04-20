export type SiteGenre =
  | "developer_docs"
  | "api_reference"
  | "technical_knowledge_base"
  | "help_center"
  | "saas_product"
  | "marketing_site"
  | "ecommerce_store"
  | "marketplace"
  | "media_publication"
  | "blog"
  | "community_forum"
  | "social_platform"
  | "event_site"
  | "entertainment"
  | "government"
  | "academic_research"
  | "nonprofit"
  | "corporate"
  | "portfolio"
  | "personal"
  | "landing_page"
  | "directory_listing"
  | "generic"

export type FetchStatus = "ok" | "timeout" | "error" | "skipped"

export type DescriptionProvenance =
  | "json_ld" | "og" | "meta" | "excerpt" | "heading" | "llm" | "none"

export interface ExtractedPage {
  url: string
  mdUrl?: string
  title: string
  description?: string
  bodyExcerpt?: string
  headings: string[]
  lang?: string
  canonical?: string
  fetchStatus: FetchStatus
  descriptionProvenance: DescriptionProvenance
}

export interface ScoredPage extends ExtractedPage {
  score: number
  section?: string
  llmSection?: string
  isOptional: boolean
}

export interface JobProgress {
  discovered: number
  crawled: number
  failed: number
  /**
   * How the crawler is fetching pages. `"http"` is the plain-fetch
   * fast path with N concurrent workers; `"browser"` falls back to
   * Puppeteer for sites that return a JS shell under plain fetch,
   * which renders pages one at a time (same Chromium process). Set
   * once the pipeline decides which path to take; the progress UI
   * reads this to explain the slower latency of the browser path.
   */
  mode?: "http" | "browser"
}

export type JobStatus =
  | "pending" | "crawling" | "enriching" | "scoring" | "assembling"
  | "complete" | "failed" | "partial"

export interface CrawlJob {
  id: string
  url: string
  status: JobStatus
  progress: JobProgress
  genre?: SiteGenre
  siteName?: string
  result?: string
  pages?: ScoredPage[]
  error?: string
  createdAt: Date
  updatedAt: Date
  /**
   * Stamped when the monitor cron checks the page for drift (whether or
   * not content changed) AND when a crawl completes. Drives the "Refreshed
   * X ago" label + the Refresh button in ResultPane.
   */
  lastCheckedAt?: Date
}
