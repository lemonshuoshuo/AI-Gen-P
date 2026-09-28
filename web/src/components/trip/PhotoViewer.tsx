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
    'absolute top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white/80 backdrop-blur transition-colors duration-300 hover:border-white/50 hover:text-white'
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="查看照片"
      className="animate-fade-in fixed inset-0 z-[120] flex flex-col bg-paper text-white"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3 md:px-8 md:py-5">
        <span className="font-num text-[15px] tracking-[0.12em] text-white/60">
          {String(i + 1).padStart(2, '0')} <span className="text-white/30">/</span> {String(photos.length).padStart(2, '0')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 flex size-11 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="关闭"
        >
          <X className="size-6" strokeWidth={1.25} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 md:px-20" onClick={(e) => e.stopPropagation()}>
        <img key={p.id} src={p.url} alt={p.caption} className="animate-fade-in max-h-full max-w-full object-contain" />
        {i > 0 && (
          <button type="button" onClick={() => setI(i - 1)} className={`${navBtn} left-3`} aria-label="上一张">
            <ChevronLeft className="size-6" strokeWidth={1.25} />
          </button>
        )}
        {i < photos.length - 1 && (
          <button type="button" onClick={() => setI(i + 1)} className={`${navBtn} right-3`} aria-label="下一张">
            <ChevronRight className="size-6" strokeWidth={1.25} />
          </button>
        )}
      </div>
      {/* 说明文字对：第一行亮、第二行灰 */}
      <div
        className="mx-4 border-t border-white/10 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-[13px] leading-[1.5] md:mx-8 md:pb-7"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-white">
          {p.caption || where || '\u00a0'}
        </p>
        <p className="text-white/55">
          {p.caption && where && (
            <>
              <MapPin className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={1.25} />
              {where}
              {p.taken_at && <span className="mx-2 text-white/25">·</span>}
            </>
          )}
          {p.taken_at && <span className="font-num text-[14px]">{fmtTime(p.taken_at, 'YYYY.MM.DD HH:mm')}</span>}
        </p>
      </div>
    </div>,
    document.body,
  )
}
