"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronDown, LogOut } from "lucide-react"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"

export default function NavAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const supabase = useRef(createClient()).current
  const router = useRouter()

  // Track auth for the lifetime of the page. getUser() settles the
  // initial state; onAuthStateChange covers subsequent transitions
  // (including INITIAL_SESSION fired on first subscribe when the user
  // is already signed in).
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user))
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setUser(session?.user ?? null),
    )
    return () => subscription.unsubscribe()
  }, [supabase])

  // Close the menu on click-outside and on Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const signOut = async () => {
    setOpen(false)
    await supabase.auth.signOut()
    router.refresh()
  }

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

  // Prefer email but fall back to a neutral label if Supabase doesn't
  // expose it (e.g. phone-based provider in a future iteration).
  const label = user.email ?? "Account"

  return (
    <div className="flex items-center gap-4">
      <Link
        href="/dashboard"
        className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
      >
        Dashboard
      </Link>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className="flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 rounded-md px-1 py-0.5"
        >
          <span className="hidden sm:inline text-xs text-zinc-500 truncate max-w-[12rem]">{label}</span>
          <ChevronDown
            size={12}
            className={`text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-50 w-48 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden"
          >
            {/* Show the email inside the menu on small screens where
                we hide it from the trigger to save horizontal space. */}
            <div className="sm:hidden px-3 py-2 text-xs text-zinc-500 border-b border-zinc-100 truncate">
              {label}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 text-left"
            >
              <LogOut size={13} className="text-zinc-400" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
