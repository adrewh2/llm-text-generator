import Link from "next/link"
import type { ReactNode } from "react"

// Shared top nav across landing, dashboard, and login. The logo is
// locked to the left `px-6` edge so it sits in the same spot on every
// page. Callers pass page-specific content (nav links, NavAuth) as
// `right`; pages that want nothing on the right can omit it.
export default function AppHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-sm border-b border-zinc-100">
      <nav className="px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-6 h-6 bg-zinc-950 rounded-[5px] flex items-center justify-center shrink-0">
            <span className="text-white font-mono text-[9px] font-bold leading-none">{"//"}</span>
          </div>
          <span className="font-semibold text-zinc-950 text-sm tracking-tight">llms.txt</span>
        </Link>
        {right}
      </nav>
    </header>
  )
}
