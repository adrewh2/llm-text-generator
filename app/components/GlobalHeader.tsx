"use client"

import { usePathname } from "next/navigation"
import type { User } from "@supabase/supabase-js"
import AppHeader from "./AppHeader"
import NavAuth from "./NavAuth"

// Rendered once in the root layout so landing ↔ dashboard ↔ login
// navigations reuse the SAME header instance — usePathname changes
// value, NavAuth swaps its link, and the avatar stays mounted. That
// eliminates the "unmount old header / mount new header" flash that
// happens when each page.tsx renders its own AppHeader.
//
// /p/{id} is the one exception: it needs a page-specific center slot
// (domain + spec chip + page count), so it owns its own AppHeader
// and this component hides on that route. Transitions between /p/*
// and everything else still rebuild the header — worth it vs. the
// complexity of context-driven center-slot injection.
export default function GlobalHeader({ initialUser }: { initialUser: User | null }) {
  const pathname = usePathname() ?? "/"
  if (pathname.startsWith("/p/")) return null
  const showHowItWorks = pathname === "/"
  return (
    <AppHeader
      right={
        <div className="flex items-center gap-3 sm:gap-4">
          {showHowItWorks && (
            <a
              href="#how-it-works"
              className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
            >
              How it works
            </a>
          )}
          <NavAuth initialUser={initialUser} />
        </div>
      }
    />
  )
}
