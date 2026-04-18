import type { Metadata } from "next"
import { Geist, Geist_Mono, Newsreader } from "next/font/google"
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  )
}
