"use client"

interface Props {
  title: string
  body: string
  note?: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ title, body, note, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  // stopPropagation + preventDefault on every click handler so dialog
  // clicks never reach ancestor anchors / Links in the React tree.
  const cancel = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onCancel() }
  const confirm = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onConfirm() }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4" onClick={cancel}>
      <div
        className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm"
        onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        <h3 className="text-sm font-semibold text-zinc-950 mb-2">{title}</h3>
        <p className="text-sm text-zinc-500 leading-relaxed">{body}</p>
        {note && (
          <p className="text-xs text-zinc-400 mt-3 leading-relaxed border-t border-zinc-100 pt-3">{note}</p>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={cancel}
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 px-4 py-2 rounded-lg border border-zinc-200 hover:bg-zinc-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
