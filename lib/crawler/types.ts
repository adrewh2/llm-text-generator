export type PageType =
  | "doc" | "api" | "example" | "blog" | "changelog"
  | "about" | "product" | "pricing" | "support" | "policy"
  | "program" | "news" | "project" | "other"

export type SiteGenre =
  | "developer_docs" | "ecommerce" | "personal_site"
  | "institutional" | "blog_publication" | "generic"

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
  pageType: PageType
  score: number
  section?: string
  llmSection?: string
  isOptional: boolean
}

export interface JobProgress {
  discovered: number
  crawled: number
  failed: number
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
}
