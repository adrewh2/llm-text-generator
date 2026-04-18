"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import ConfirmDialog from "@/app/components/ConfirmDialog"

export default function JobActions({ pageUrl }: { pageUrl: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const handleRemove = async () => {
    setConfirmDelete(false)
    setBusy(true)
    try {
      await fetch(`/api/p/request?pageUrl=${encodeURIComponent(pageUrl)}`, { method: "DELETE" })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {confirmDelete && (
        <ConfirmDialog
          title="Remove from history?"
          body="This removes the page from your history. The llms.txt result remains accessible to anyone with the link."
          confirmLabel="Remove"
          onConfirm={handleRemove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      <div ref={ref} className="relative" onClick={(e) => e.preventDefault()}>
        <button
          onClick={(e) => { e.preventDefault(); setOpen((o) => !o) }}
          disabled={busy}
          className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors disabled:opacity-40"
        >
          <MoreHorizontal size={15} />
        </button>
        {open && (
          <div className="absolute right-0 top-8 z-50 w-44 bg-white border border-zinc-200 rounded-xl shadow-lg overflow-hidden">
            <button
              onClick={(e) => { e.preventDefault(); setOpen(false); setConfirmDelete(true) }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <Trash2 size={13} className="text-red-400" />
              Remove from history
            </button>
          </div>
        )}
      </div>
    </>
  )
}
