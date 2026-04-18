"use client"

import { createClient } from "@/lib/supabase/client"
import { useRouter } from "next/navigation"

export default function SignOutButton() {
  const supabase = createClient()
  const router = useRouter()

  const signOut = async () => {
    await supabase.auth.signOut()
    router.push("/")
    router.refresh()
  }

  return (
    <button
      onClick={signOut}
      className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors"
    >
      Sign out
    </button>
  )
}
