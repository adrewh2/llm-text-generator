import Link from "next/link"
import { ArrowRight } from "lucide-react"

// Shared 404 card used by both the root not-found.tsx and the nested
// /p/[id] not-found. Header handling differs between them (GlobalHeader
// renders over the root version; /p/* hides it and its not-found
// supplies its own AppHeader), but the card itself is identical.
export default function NotFoundScreen() {
  return (
    <div className="relative min-h-[calc(100vh-57px)] bg-white flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-[11px] font-mono text-zinc-400 tracking-[0.18em] uppercase mb-4">
          404
        </p>
        <h1 className="text-3xl font-semibold text-zinc-950 tracking-tight mb-3">
          Page not found
        </h1>
        <p className="text-sm text-zinc-500 leading-relaxed mb-8">
          This page doesn&apos;t exist, or the result you&apos;re looking for
          has expired. Start a fresh crawl from the homepage.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 bg-zinc-950 text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-zinc-800 active:scale-[0.98] transition-all"
        >
          Generate a new llms.txt
          <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  )
}
