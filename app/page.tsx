import { getCurrentUser } from "@/lib/supabase/getUser"
import LandingClient from "./LandingClient"

// Seed LandingClient with the server-resolved user so the
// signed-in-only CTA + heading render with the correct wording on
// first paint instead of flashing the anon copy.
export default async function HomePage() {
  const user = await getCurrentUser()
  return <LandingClient initialUser={user} />
}
