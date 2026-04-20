import Link from "next/link"
import type { ReactNode } from "react"

// One bordered pill used for every right-side header CTA (Generate,
// Dashboard) across every page — keeps size, padding, and icon
// alignment consistent so navigation doesn't cause visible jumps.
export const HEADER_BUTTON_CLASS =
  "flex items-center gap-1.5 text-sm text-zinc-700 hover:text-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-colors"

// Shared top nav across landing, dashboard, login, and /p/{id}. The
// logo is locked to the left `px-6` edge so it sits in the same spot
// on every page. `center` takes page-specific inline content (e.g.
// the current domain + spec chip on /p/{id}); `right` takes the
// shrink-0 right-aligned actions (NavAuth, Generate button, etc.).
export default function AppHeader({
  center,
  right,
}: {
  center?: ReactNode
  right?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-xs border-b border-zinc-100">
      <nav className="pl-6 pr-4 sm:pr-6 h-14 flex items-center gap-3 sm:gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <div className="w-6 h-6 bg-zinc-950 rounded-[5px] flex items-center justify-center shrink-0">
            <span className="text-white font-mono text-[9px] font-bold leading-none">{"//"}</span>
          </div>
          <span className="font-semibold text-zinc-950 text-sm tracking-tight">llms.txt</span>
        </Link>
        <div className="flex-1 min-w-0 flex items-center gap-2">{center}</div>
        {right && <div className="shrink-0">{right}</div>}
      </nav>
    </header>
  )
}
