"use client"

import { useEffect, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"
import type { User } from "@supabase/supabase-js"

export default function NavAuth() {
  const [user, setUser] = useState<User | null>(null)
  const supabase = useRef(createClient()).current

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [supabase])

  if (user) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-xs text-zinc-400 hidden sm:block">{user.email}</span>
        <Link
          href="/dashboard"
          className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
        >
          Dashboard
        </Link>
      </div>
    )
  }

  return (
    <Link
      href="/login"
      className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
    >
      Sign in
    </Link>
  )
}
