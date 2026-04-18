"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import ConfirmDialog from "@/app/components/ConfirmDialog"

interface Props {
  pageUrl: string
  /**
   * Optional callback for optimistic UI: when provided, the parent
   * removes the row from its local state so the trash feels instant.
   * Falls back to `router.refresh()` (full RSC re-render) when absent.
   */
  onRemoved?: (pageUrl: string) => void
}

export default function JobActions({ pageUrl, onRemoved }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  const handleRemove = async () => {
    setConfirmDelete(false)
    setBusy(true)
    if (onRemoved) onRemoved(pageUrl) // remove from list immediately
    try {
      await fetch(`/api/p/request?pageUrl=${encodeURIComponent(pageUrl)}`, { method: "DELETE" })
      if (!onRemoved) router.refresh()
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
      <button
        type="button"
        aria-label="Remove from history"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setConfirmDelete(true)
        }}
        disabled={busy}
        className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all disabled:opacity-40"
      >
        <Trash2 size={14} />
      </button>
    </>
  )
}
