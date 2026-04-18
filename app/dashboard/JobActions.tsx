"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import ConfirmDialog from "@/app/components/ConfirmDialog"

export default function JobActions({ pageUrl }: { pageUrl: string }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

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
