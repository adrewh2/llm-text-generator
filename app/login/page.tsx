"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { ArrowLeft, Github } from "lucide-react"
import Link from "next/link"

export default function LoginPage() {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState("")
  // Stash the Supabase client behind a ref so its identity stays
  // stable across renders. Previously `createClient()` ran in the
  // render body and the `useEffect` below depended on `supabase`,
  // which made the effect fire on every render.
  const supabase = useRef(createClient()).current
  const router = useRouter()

  // Already signed in → skip the login screen entirely. Prevents the
  // awkward "sign in again" flash for users who have a valid session
  // but accidentally navigate back to /login.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace("/")
    })
  }, [supabase, router])

  const signIn = async (provider: "github" | "google") => {
    setLoading(provider)
    setError("")
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) {
      setError(error.message)
      setLoading(null)
    }
  }

  return (
    // Root layout owns the sticky GlobalHeader (h-14 nav + 1px
    // border-b = 57px rendered). Subtract that exact height so
    // body total = header + login = 100vh and no scrollbar appears.
    // Tailwind arbitrary values need underscores for spaces in calc.
    <div className="relative min-h-[calc(100vh_-_57px)] bg-white flex items-center justify-center px-6">
      {/* Absolute so the Back link doesn't push the centered card down
          — without it the card's vertical midpoint sits below the
          viewport's because the Back row is pre-card flex content. */}
      <Link
        href="/"
        className="absolute top-6 left-6 inline-flex items-center gap-2 text-base text-zinc-600 hover:text-zinc-900 transition-colors"
      >
        <ArrowLeft size={18} />
        Back
      </Link>

      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-zinc-950 tracking-tight">Sign in</h1>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => signIn("github")}
            disabled={!!loading}
            className="w-full flex items-center justify-center gap-3 bg-zinc-950 text-white text-base font-medium px-5 py-3 rounded-xl hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <Github size={20} />
            {loading === "github" ? "Redirecting…" : "Continue with GitHub"}
          </button>

          <button
            onClick={() => signIn("google")}
            disabled={!!loading}
            className="w-full flex items-center justify-center gap-3 bg-white text-zinc-900 text-base font-medium px-5 py-3 rounded-xl border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {loading === "google" ? "Redirecting…" : "Continue with Google"}
          </button>
        </div>

        {error && <p className="text-xs text-red-500 mt-4 text-center">{error}</p>}

        <p className="text-sm text-zinc-500 text-center mt-8">
          Sign in for tracked history and higher usage limits.
        </p>
      </div>
    </div>
  )
}
