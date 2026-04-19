"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"

// Circular avatar + dropdown. Prefers the OAuth provider's avatar_url
// (Supabase stores it under user.user_metadata.avatar_url for GitHub
// and Google logins); falls back to the first letter of the email in
// a neutral circle. The dropdown shows the account email + Sign out.
export default function UserMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const supabase = useRef(createClient()).current
  const router = useRouter()

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
    // Always land on the public landing page — otherwise a sign-out
    // from /dashboard leaves the user on a page that's gated server-
    // side and would bounce them to /login on refresh.
    router.push("/")
    router.refresh()
  }

  const metadata = (user.user_metadata ?? {}) as {
    avatar_url?: string
    picture?: string
    full_name?: string
    name?: string
  }
  // Google sets `picture`; GitHub sets `avatar_url`. Check both so
  // either provider surfaces the real photo.
  const avatarUrl = metadata.avatar_url ?? metadata.picture
  // Flip to fallback if the remote image 403s / errors out (Google
  // avatars occasionally do on refresh), so the user never sees the
  // browser's broken-image placeholder.
  const [imgError, setImgError] = useState(false)
  useEffect(() => { setImgError(false) }, [avatarUrl])
  const showImage = Boolean(avatarUrl) && !imgError
  const initials = computeInitials(metadata.full_name ?? metadata.name ?? user.email ?? "")
  const label = user.email ?? "Account"

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="block w-8 h-8 rounded-full overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2"
      >
        {showImage ? (
          // Provider-hosted image; intentionally not next/image to
          // avoid needing to whitelist github.com/google.com in
          // next.config.js just for a 32px avatar. referrerPolicy
          // keeps Google from 403'ing when the Referer exposes our
          // origin.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-zinc-200 flex items-center justify-center text-xs font-medium text-zinc-700">
            {initials}
          </div>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 z-50 w-48 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-100 truncate">
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
  )
}

// Pull up to two initials from a display name. Prefers first+last
// initial for multi-word names ("Jane Doe" → "JD"); falls back to a
// single letter for single-word names or emails (where we use the
// local-part's first character). Always returns a non-empty string.
function computeInitials(raw: string): string {
  const source = raw.trim()
  if (!source) return "U"
  if (source.includes("@")) {
    return source.charAt(0).toUpperCase() || "U"
  }
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "U"
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase() || "U"
  const first = parts[0].charAt(0)
  const last = parts[parts.length - 1].charAt(0)
  return (first + last).toUpperCase() || "U"
}
