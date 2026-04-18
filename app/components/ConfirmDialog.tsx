"use client"

import { useEffect, useRef } from "react"

interface Props {
  title: string
  body: string
  note?: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  body,
  note,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: Props) {
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  // Remember what had focus before we opened so we can return focus
  // there on close (standard modal a11y contract). Move focus to the
  // Cancel button so keyboard users land on the safe action.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    cancelButtonRef.current?.focus()
    return () => {
      previouslyFocused.current?.focus?.()
    }
  }, [])

  // Escape cancels. Tab / Shift+Tab are trapped between Cancel and
  // Confirm so the two buttons form a two-element focus cycle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== "Tab") return
      const active = document.activeElement
      if (e.shiftKey && active === cancelButtonRef.current) {
        e.preventDefault()
        confirmButtonRef.current?.focus()
      } else if (!e.shiftKey && active === confirmButtonRef.current) {
        e.preventDefault()
        cancelButtonRef.current?.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  // stopPropagation + preventDefault on every click handler so dialog
  // clicks never reach ancestor anchors / Links in the React tree.
  const cancel = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onCancel() }
  const confirm = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onConfirm() }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4"
      onClick={cancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm"
        onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        <h3 id="confirm-title" className="text-sm font-semibold text-zinc-950 mb-2">{title}</h3>
        <p className="text-sm text-zinc-500 leading-relaxed">{body}</p>
        {note && (
          <p className="text-xs text-zinc-400 mt-3 leading-relaxed border-t border-zinc-100 pt-3">{note}</p>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button
            ref={cancelButtonRef}
            onClick={cancel}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 px-4 py-2 rounded-lg border border-zinc-200 hover:bg-zinc-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            onClick={confirm}
            className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
