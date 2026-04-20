import { cache } from "react"
import { createClient } from "./server"

// Request-scoped memoized getUser. React's cache() dedupes calls within
// a single RSC render / route-handler invocation into one Supabase Auth
// round-trip — a dashboard page that reads the user in layout + page
// drops from three hits to one. Middleware is a separate execution
// context; its own getUser() call stays as-is.
export const getCurrentUser = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})
