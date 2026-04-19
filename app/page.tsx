import { createClient } from "@/lib/supabase/server"
import LandingClient from "./LandingClient"

// Seed LandingClient with the server-resolved user so the
// signed-in-only CTA + heading render with the correct wording on
// first paint instead of flashing the anon copy.
export default async function HomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return <LandingClient initialUser={user} />
}
