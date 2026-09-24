import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, MapPin, X } from 'lucide-react'
import type { Photo } from '@/api/types'
import { fmtTime } from '@/lib/format'

export function PhotoViewer({
  photos,
  index,
  onClose,
  captionOf,
}: {
  photos: Photo[]
  index: number | null
  onClose: () => void
  captionOf?: (p: Photo) => string | undefined
}) {
  const [i, setI] = useState(index ?? 0)
  useEffect(() => {
    if (index != null) setI(index)
  }, [index])
  useEffect(() => {
    if (index == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1))
      if (e.key === 'ArrowRight') setI((v) => Math.min(photos.length - 1, v + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, photos.length, onClose])
  if (index == null || !photos[i]) return null
  const p = photos[i]
  const where = captionOf?.(p)
  return createPortal(
    <div className="animate-fade-in fixed inset-0 z-[120] flex flex-col bg-black/95 text-white" onClick={onClose}>
      <div className="flex items-center justify-between p-3 text-sm">
        <span className="tabular-nums text-white/60">
          {i + 1} / {photos.length}
        </span>
        <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-white/10" aria-label="关闭">
          <X className="size-6" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2" onClick={(e) => e.stopPropagation()}>
        <img src={p.url} alt={p.caption} className="max-h-full max-w-full rounded-lg object-contain" />
        {i > 0 && (
          <button
            type="button"
            onClick={() => setI(i - 1)}
            className="absolute left-2 rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="上一张"
          >
            <ChevronLeft className="size-6" />
          </button>
        )}
        {i < photos.length - 1 && (
          <button
            type="button"
            onClick={() => setI(i + 1)}
            className="absolute right-2 rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="下一张"
          >
            <ChevronRight className="size-6" />
          </button>
        )}
      </div>
      <div className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm" onClick={(e) => e.stopPropagation()}>
        {p.caption && <p className="mb-1">{p.caption}</p>}
        <p className="text-white/50">
          {where && (
            <>
              <MapPin className="mr-0.5 inline size-3.5" />
              {where}
              {'  '}
            </>
          )}
          {p.taken_at && fmtTime(p.taken_at, 'YYYY-MM-DD HH:mm')}
        </p>
      </div>
    </div>,
    document.body,
  )
}
