import type { Metadata } from "next"
import { Geist, Geist_Mono, Newsreader } from "next/font/google"
import { createClient } from "@/lib/supabase/server"
import GlobalHeader from "./GlobalHeader"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

// Display serif for the landing-page hero. Newsreader has wide
// apertures and standard terminals — soft without Fraunces's quirky
// `f` and not compressed like Instrument Serif.
const displaySerif = Newsreader({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "variable",
})

export const metadata: Metadata = {
  title: "llms.txt Generator",
  description: "Generate a spec-compliant llms.txt file for any website in seconds.",
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve auth once for the layout — NavAuth gets seeded from this
  // server snapshot so the "Sign in" → avatar swap on first render
  // never flashes the anon state for a signed-in user.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} font-sans antialiased`}
      >
        <GlobalHeader initialUser={user} />
        {children}
      </body>
    </html>
  )
}
