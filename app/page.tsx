import LandingClient from "./LandingClient"

// Auth is now resolved once in the root layout and seeded into
// GlobalHeader/NavAuth, so this page no longer needs its own
// createClient() round-trip.
export default function HomePage() {
  return <LandingClient />
}
