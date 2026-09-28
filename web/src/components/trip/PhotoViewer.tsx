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
  const navBtn =
    'absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/80 transition-colors hover:border-white/40 hover:text-white'
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="查看照片"
      className="animate-fade-in fixed inset-0 z-[120] flex flex-col bg-[#0c1314]/[0.97] text-white"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-num text-sm tracking-widest text-white/55">
          {String(i + 1).padStart(2, '0')} <span className="text-white/25">/</span> {String(photos.length).padStart(2, '0')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="关闭"
        >
          <X className="size-6" strokeWidth={1.5} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2" onClick={(e) => e.stopPropagation()}>
        <img src={p.url} alt={p.caption} className="max-h-full max-w-full rounded-md object-contain" />
        {i > 0 && (
          <button type="button" onClick={() => setI(i - 1)} className={`${navBtn} left-3`} aria-label="上一张">
            <ChevronLeft className="size-6" strokeWidth={1.5} />
          </button>
        )}
        {i < photos.length - 1 && (
          <button type="button" onClick={() => setI(i + 1)} className={`${navBtn} right-3`} aria-label="下一张">
            <ChevronRight className="size-6" strokeWidth={1.5} />
          </button>
        )}
      </div>
      <div className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center" onClick={(e) => e.stopPropagation()}>
        {p.caption && <p className="font-display mb-1.5 text-[15px] text-white/90">{p.caption}</p>}
        <p className="text-xs tracking-wide text-white/50">
          {where && (
            <>
              <MapPin className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={1.5} />
              {where}
              {p.taken_at && <span className="mx-2 text-white/25">·</span>}
            </>
          )}
          {p.taken_at && <span className="font-num">{fmtTime(p.taken_at, 'YYYY.MM.DD HH:mm')}</span>}
        </p>
      </div>
    </div>,
    document.body,
  )
}
