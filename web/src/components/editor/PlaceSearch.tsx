import { useEffect, useRef, useState } from 'react'
import { Loader2, MapPin, Search, X } from 'lucide-react'
import { api, type GeoSearchItem } from '@/api'
import { CategoryChip } from '@/components/ui'
import { cn } from '@/lib/cn'

export function PlaceSearch({
  onPick,
  city,
  near,
  placeholder = '搜索景点、餐厅、酒店、街道…',
  className,
  autoFocus,
}: {
  onPick: (item: GeoSearchItem) => void
  city?: string
  near?: [number, number] | null
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  const [kw, setKw] = useState('')
  const [items, setItems] = useState<GeoSearchItem[]>([])
  const [source, setSource] = useState<'amap' | 'local' | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const k = kw.trim()
    if (!k) {
      setItems([])
      return
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setLoading(true)
      try {
        const r = await api.geo.search({ keyword: k, city, lng: near?.[0], lat: near?.[1] }, ac.signal)
        setItems(r.items)
        setSource(r.source)
        setOpen(true)
      } catch {
        /* 忽略中断 */
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [kw, city, near])

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
        <input
          value={kw}
          autoFocus={autoFocus}
          onChange={(e) => setKw(e.target.value)}
          onFocus={() => items.length && setOpen(true)}
          placeholder={placeholder}
          className="h-11 w-full rounded-xl border border-ink-200 bg-white pr-9 pl-9 text-sm outline-none focus:border-brand-400 focus:ring-4 focus:ring-brand-100"
        />
        {loading ? (
          <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-ink-400" />
        ) : (
          kw && (
            <button
              type="button"
              onClick={() => {
                setKw('')
                setItems([])
              }}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-ink-400"
              aria-label="清空"
            >
              <X className="size-4" />
            </button>
          )
        )}
      </div>
      {open && kw.trim() && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 z-40 mt-1.5 max-h-80 overflow-y-auto rounded-2xl bg-white py-1 shadow-float ring-1 ring-ink-100">
            {source === 'local' && (
              <p className="border-b border-ink-100 px-4 py-2 text-xs text-amber-700">
                服务器未配置高德 Key，只能搜索城市。具体地点请直接在地图上点选。
              </p>
            )}
            {items.length === 0 && !loading && <p className="px-4 py-3 text-sm text-ink-400">没有找到相关地点</p>}
            {items.map((it, i) => (
              <button
                key={`${it.amap_id}-${i}`}
                type="button"
                onClick={() => {
                  onPick(it)
                  setOpen(false)
                  setKw('')
                }}
                className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-ink-50"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-brand-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{it.name}</span>
                    {it.category && <CategoryChip category={it.category} />}
                  </div>
                  <div className="truncate text-xs text-ink-400">
                    {[it.city, it.district, it.address].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
