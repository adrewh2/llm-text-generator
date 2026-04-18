import { createClient } from "@/lib/supabase/server"
import LandingClient from "./LandingClient"

// Resolve auth on the server so NavAuth's first render already knows
// whether the user is signed in. Without this the landing page
// hydrates with "Sign in" showing and flips to the account menu a
// tick later — a noticeable flicker when navigating from /dashboard
// back to /. `createClient` reads the session cookie, which makes
// this route dynamic automatically.
export default async function HomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return <LandingClient initialUser={user} />
}
