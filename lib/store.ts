import { createClient } from "@supabase/supabase-js"
import type { CrawlJob } from "./crawler/types"

function getClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY")
  return createClient(url, key)
}

function toJob(row: Record<string, unknown>): CrawlJob {
  return {
    id: row.id as string,
    url: row.url as string,
    status: row.status as CrawlJob["status"],
    progress: row.progress as CrawlJob["progress"],
    result: row.result as string | undefined,
    pages: row.pages as CrawlJob["pages"],
    genre: row.genre as CrawlJob["genre"],
    siteName: row.site_name as string | undefined,
    error: row.error as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

export async function createJob(id: string, url: string): Promise<CrawlJob> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from("jobs")
    .insert({ id, url, status: "pending", progress: { discovered: 0, crawled: 0, failed: 0 } })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return toJob(data)
}

export async function getJob(id: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  const { data, error } = await supabase.from("jobs").select("*").eq("id", id).single()
  if (error || !data) return undefined
  return toJob(data)
}

export async function updateJob(id: string, updates: Partial<CrawlJob>): Promise<void> {
  const supabase = getClient()
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.status !== undefined) row.status = updates.status
  if (updates.progress !== undefined) row.progress = updates.progress
  if (updates.result !== undefined) row.result = updates.result
  if (updates.pages !== undefined) row.pages = updates.pages
  if (updates.genre !== undefined) row.genre = updates.genre
  if (updates.siteName !== undefined) row.site_name = updates.siteName
  if (updates.error !== undefined) row.error = updates.error
  await supabase.from("jobs").update(row).eq("id", id)
}
