import AppHeader from "@/app/components/AppHeader"
import NavAuth from "@/app/components/NavAuth"
import NotFoundScreen from "@/app/components/NotFoundScreen"
import { getCurrentUser } from "@/lib/supabase/getUser"

// GlobalHeader hides on /p/* so the result page can own its own header.
// That leaves the root not-found.tsx headerless here, so this nested
// not-found supplies the standard AppHeader + NavAuth directly.
export default async function PageNotFound() {
  const user = await getCurrentUser()
  return (
    <>
      <AppHeader right={<NavAuth initialUser={user} />} />
      <NotFoundScreen />
    </>
  )
}
