import type { MetadataRoute } from "next"

const BASE_URL = "https://llm-text-generator.vercel.app"

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    { url: `${BASE_URL}/`,        lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${BASE_URL}/login`,   lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ]
}
