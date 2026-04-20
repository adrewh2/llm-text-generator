"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { LayoutDashboard, Plus } from "lucide-react"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { HEADER_BUTTON_CLASS } from "./AppHeader"
import UserMenu from "./UserMenu"

export default function NavAuth({ initialUser = null }: { initialUser?: User | null }) {
  // Seeded from the server so hydration matches reality — prevents the
  // "Sign in" → signed-in flash when navigating from /dashboard back
  // to /, which is the common case for signed-in users.
  const [user, setUser] = useState<User | null>(initialUser)
  const supabase = useRef(createClient()).current
  const pathname = usePathname()
  // On / and /dashboard we show one contextual action (the other is
  // redundant — / IS "Generate", /dashboard IS "Dashboard"). Everywhere
  // else — /login, 404, etc. — show both so the user has a way back to
  // either core surface.
  const onDashboard = pathname?.startsWith("/dashboard") ?? false
  const onHome = pathname === "/"

  // Keep the client state in sync with live auth changes. We skip the
  // one-shot getUser() call here — initialUser from the server is the
  // authoritative initial value and already matches the session cookie
  // that the browser client would resolve to anyway.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Ignore INITIAL_SESSION: it fires synchronously on subscribe
        // with whatever the client can resolve from cookies at that
        // instant, which is occasionally null before the browser
        // finishes hydrating the auth cookie. Acting on it would
        // downgrade a signed-in user to the "Sign in" link for one
        // frame and then flip back — the navbar flicker. We already
        // seeded `user` from initialUser (SSR cookie read), so trust
        // that until a real auth event (SIGNED_IN, SIGNED_OUT,
        // TOKEN_REFRESHED, USER_UPDATED) arrives.
        if (event === "INITIAL_SESSION") return
        setUser(session?.user ?? null)
      },
    )
    return () => subscription.unsubscribe()
  }, [supabase])

  if (!user) {
    return (
      <Link
        href="/login"
        className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
      >
        Sign in
      </Link>
    )
  }

  const generateBtn = (
    <Link href="/" className={HEADER_BUTTON_CLASS} aria-label="Generate">
      <Plus size={14} className="text-zinc-400" />
      <span>Generate</span>
    </Link>
  )
  const dashboardBtn = (
    <Link href="/dashboard" className={HEADER_BUTTON_CLASS} aria-label="Dashboard">
      <LayoutDashboard size={14} className="text-zinc-400" />
      <span>Dashboard</span>
    </Link>
  )

  return (
    <div className="flex items-center gap-2 sm:gap-4">
      {onDashboard ? generateBtn : onHome ? dashboardBtn : (<>{generateBtn}{dashboardBtn}</>)}
      <UserMenu user={user} />
    </div>
  )
}
