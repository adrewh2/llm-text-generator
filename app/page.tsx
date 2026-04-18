"use client"

import { useState, useEffect, useRef } from "react"
import { ArrowRight, Globe, Zap, CheckCircle, RefreshCw, Loader2, BookMarked, FolderDown } from "lucide-react"
import { useRouter } from "next/navigation"
import NavAuth from "./NavAuth"

const EXAMPLE_OUTPUT = `# FastHTML

> FastHTML is a Python library for building server-rendered hypermedia applications with HTMX and Starlette.

## Docs

- [Quick start](https://docs.fasthtml.com/quickstart.md): A brief overview of many FastHTML features
- [HTMX reference](https://github.com/bigskysoftware/htmx/blob/master/www/content/reference.md): All HTMX attributes, CSS classes, and events

## Examples

- [Todo list application](https://github.com/AnswerDotAI/fasthtml/blob/main/examples/adv_app.py): Complete CRUD walkthrough showing idiomatic FastHTML patterns

## Optional

- [Starlette docs](https://gist.githubusercontent.com/jph00/.../starlette-sml.md): Starlette subset useful for FastHTML development`

export default function LandingPage() {
  const [url, setUrl] = useState("")
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("focus") === "1") {
      inputRef.current?.focus()
    }
  }, [])

  const normalizeInput = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return trimmed
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!url.trim() || loading) return

    const normalized = normalizeInput(url)
    setError("")
    setLoading(true)

    try {
      const res = await fetch("/api/p", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Something went wrong")
        setLoading(false)
        return
      }

      router.push(`/p/${data.page_id}${data.cached ? "?simulate=1" : ""}`)
      // leave loading=true — component unmounts on redirect
    } catch {
      setError("Network error — please try again")
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Navigation */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-zinc-100">
        <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-zinc-950 rounded-[5px] flex items-center justify-center shrink-0">
              <span className="text-white font-mono text-[9px] font-bold leading-none">//</span>
            </div>
            <span className="font-semibold text-zinc-950 text-sm tracking-tight">llms.txt</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#how-it-works" className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors hidden sm:block">
              How it works
            </a>
            <NavAuth />
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle, rgba(0,0,0,0.06) 1px, transparent 1px)`,
            backgroundSize: "28px 28px",
          }}
        />
        <div className="absolute bottom-0 inset-x-0 h-40 bg-gradient-to-t from-white to-transparent pointer-events-none" />

        <div className="relative max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 bg-white border border-zinc-200 rounded-full px-3.5 py-1.5 mb-8 shadow-sm">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[11px] text-zinc-500 font-medium tracking-wide uppercase">
              Spec-compliant · llmstxt.org
            </span>
          </div>

          <h1 className="text-[clamp(2.5rem,7vw,4.5rem)] font-display text-zinc-950 leading-[1.05] tracking-tight mb-5">
            Generate{" "}
            <span className="inline-flex items-center font-mono bg-zinc-950 text-white px-3 py-0.5 rounded-lg text-[0.78em] align-[0.08em] mx-1">
              llms.txt
            </span>
            <br className="hidden sm:block" />
            {" "}for any website
          </h1>

          <p className="text-lg text-zinc-500 max-w-lg mx-auto mb-10 leading-relaxed">
            Crawl a site, extract its key pages, and get a spec-compliant{" "}
            <code className="text-zinc-700 text-[0.9em] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">
              llms.txt
            </code>{" "}
            in seconds.
          </p>

          <form className="max-w-lg mx-auto" onSubmit={handleSubmit}>
            <div
              className={`flex items-center bg-white border rounded-xl p-1.5 shadow-sm transition-all duration-200 ${
                focused
                  ? "border-zinc-900 shadow-[0_0_0_3px_rgba(9,9,11,0.06)]"
                  : error
                  ? "border-red-400"
                  : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <Globe size={15} className="ml-2.5 text-zinc-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError("") }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="https://your-website.com"
                className="flex-1 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 bg-transparent outline-none font-mono"
                required
                disabled={loading}
              />
              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="flex items-center gap-1.5 bg-zinc-950 text-white text-sm font-medium px-4 py-2 rounded-[9px] hover:bg-zinc-800 active:scale-95 disabled:cursor-not-allowed transition-all whitespace-nowrap"
              >
                {loading ? (
                  <><Loader2 size={13} className="animate-spin" /> Generating…</>
                ) : (
                  <>Generate <ArrowRight size={13} /></>
                )}
              </button>
            </div>
            {error && <p className="text-xs text-red-500 mt-2 text-left">{error}</p>}
          </form>
        </div>
      </section>

      {/* Example output */}
      <section className="max-w-3xl mx-auto px-6 pb-20">
        <div className="rounded-2xl overflow-hidden border border-zinc-200 shadow-lg">
          <div className="flex items-center gap-1.5 px-4 py-3 bg-zinc-950 border-b border-zinc-800">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <div className="w-3 h-3 rounded-full bg-[#28c840]" />
            <span className="ml-3 text-zinc-500 text-xs font-mono">llms.txt — example output</span>
          </div>
          <pre className="bg-zinc-950 p-6 text-[13px] font-mono leading-[1.7] overflow-x-auto">
            {EXAMPLE_OUTPUT.split("\n").map((line, i) => {
              if (line.startsWith("# ")) return (
                <div key={i}><span className="text-zinc-500"># </span><span className="text-white font-semibold">{line.slice(2)}</span></div>
              )
              if (line.startsWith("> ")) return <div key={i} className="text-zinc-400">{line}</div>
              if (line.startsWith("## ")) return (
                <div key={i} className="mt-1"><span className="text-zinc-500">## </span><span className="text-emerald-400">{line.slice(3)}</span></div>
              )
              if (line.startsWith("- [")) {
                const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\):?(.*)$/)
                if (match) return (
                  <div key={i}>
                    <span className="text-zinc-600">- [</span><span className="text-sky-400">{match[1]}</span>
                    <span className="text-zinc-600">](</span><span className="text-zinc-500 text-[11px]">{match[2]}</span>
                    <span className="text-zinc-600">)</span>
                    {match[3] && <span className="text-zinc-500">{match[3]}</span>}
                  </div>
                )
              }
              return <div key={i} className="text-zinc-600 empty:h-2">{line}</div>
            })}
          </pre>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-zinc-100 bg-[#FAFAFA]">
        <div className="max-w-4xl mx-auto px-6 py-20">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.12em] text-center mb-14">
            How it works
          </p>
          <div className="grid md:grid-cols-3 gap-10">
            {[
              { icon: Globe, step: "01", title: "Crawl", desc: "We traverse the site via sitemap.xml, robots.txt, and link discovery — respecting robots.txt rules and prioritizing high-value pages like docs and API references." },
              { icon: Zap, step: "02", title: "Enrich", desc: "An LLM classifies each page, assigns it to a meaningful section, scores its importance, and writes a concise description — all tuned to the site's domain." },
              { icon: CheckCircle, step: "03", title: "Generate", desc: "A spec-compliant llms.txt is assembled with a generated preamble, importance-ordered sections, and an Optional section for supplementary pages. Edit, validate, and download." },
            ].map(({ icon: Icon, step, title, desc }) => (
              <div key={step} className="group">
                <div className="text-[10px] font-mono text-zinc-300 mb-4 tracking-widest">{step}</div>
                <div className="w-9 h-9 bg-white border border-zinc-200 rounded-xl flex items-center justify-center mb-4 shadow-sm">
                  <Icon size={16} className="text-zinc-700" />
                </div>
                <h3 className="font-semibold text-zinc-950 mb-2">{title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-16 p-5 rounded-xl bg-white border border-zinc-200 flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
              <RefreshCw size={14} className="text-zinc-600" />
            </div>
            <div>
              <h4 className="font-semibold text-zinc-900 text-sm mb-1">Works for any website</h4>
              <p className="text-sm text-zinc-500 leading-relaxed">
                The LLM adapts section names and descriptions to the site's domain, whether it's a recipe blog, a law firm, or a SaaS product.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Sign-in Features */}
      <section className="border-t border-zinc-200 bg-zinc-100">
        <div className="max-w-4xl mx-auto px-6 py-20">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.12em] text-center mb-14">
            Sign in for more features
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                icon: BookMarked,
                title: "Page history",
                desc: "Every llms.txt page you request is saved to your dashboard.",
              },
              {
                icon: FolderDown,
                title: "Stay up to date",
                desc: "Download a folder with the latest llms.txt versions in one click.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex items-start gap-4 p-5 rounded-xl border border-zinc-200 bg-white">
                <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                  <Icon size={15} className="text-zinc-600" />
                </div>
                <div>
                  <h4 className="font-semibold text-zinc-900 text-sm mb-1">{title}</h4>
                  <p className="text-sm text-zinc-500 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <a
              href="/login"
              className="inline-flex items-center gap-1.5 bg-zinc-950 text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-zinc-800 transition-colors"
            >
              Sign in to get started
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-100">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-zinc-950 rounded-[4px] flex items-center justify-center">
              <span className="text-white font-mono text-[8px] font-bold">//</span>
            </div>
            <span className="text-xs text-zinc-400 font-medium">llms.txt Generator</span>
          </div>
          <p className="text-xs text-zinc-400">
            Built with the{" "}
            <a href="https://llmstxt.org" className="underline hover:text-zinc-600 transition-colors">
              llmstxt.org
            </a>{" "}
            spec
          </p>
        </div>
      </footer>
    </div>
  )
}
