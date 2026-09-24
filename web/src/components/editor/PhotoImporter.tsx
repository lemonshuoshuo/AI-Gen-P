import { useRef, useState } from 'react'
import { ImagePlus, MapPin, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import { Button, Switch } from '@/components/ui'
import { preparePhotos, type PreparedPhoto } from '@/lib/photo'
import { isIOS } from '@/lib/nav'

export function PhotoImporter({
  tripId,
  onDone,
  defaultAuto = true,
  compact,
}: {
  tripId: number
  onDone: (created: number) => void
  defaultAuto?: boolean
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<PreparedPhoto[]>([])
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const [auto, setAuto] = useState(defaultAuto)

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    const list = Array.from(files).slice(0, 100)
    setPreparing({ done: 0, total: list.length })
    const out = await preparePhotos(list, (done) => setPreparing({ done, total: list.length }))
    setPreparing(null)
    out.sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? ''))
    setItems(out)
    if (out.length < list.length) toast.warning(`${list.length - out.length} 张照片无法读取，已跳过`)
  }

  const upload = async () => {
    setUploading({ done: 0, total: items.length })
    let created = 0
    let failed = 0
    // 按拍摄时间顺序逐张上传，保证自动生成的打卡点顺序正确
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      try {
        const r = await api.photos.upload(tripId, p.file, {
          filename: p.filename,
          lng: p.lng,
          lat: p.lat,
          coord_type: 'wgs84',
          taken_at: p.takenAt,
          auto_waypoint: auto && p.lng != null,
        })
        if (r.waypoint_created) created++
      } catch (e) {
        failed++
        if (failed === 1) toast.error(errorMessage(e))
        if (e instanceof Error && /配额|空间/.test(e.message)) break
      }
      setUploading({ done: i + 1, total: items.length })
    }
    items.forEach((p) => URL.revokeObjectURL(p.previewUrl))
    setItems([])
    setUploading(null)
    toast.success(`上传完成${created ? `，自动生成了 ${created} 个打卡点` : ''}${failed ? `，${failed} 张失败` : ''}`)
    onDone(created)
  }

  const withGps = items.filter((p) => p.lng != null).length

  return (
    <div className="space-y-3">
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
      {items.length === 0 ? (
        <button
          type="button"
          disabled={!!preparing}
          onClick={() => input.current?.click()}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink-200 bg-white text-ink-500 transition hover:border-brand-300 hover:text-brand-600 ${compact ? 'py-5' : 'py-10'}`}
        >
          <ImagePlus className="size-8" />
          <span className="text-sm font-medium">
            {preparing ? `正在读取照片 ${preparing.done}/${preparing.total}…` : '选择照片（可多选）'}
          </span>
          {!compact && (
            <span className="max-w-xs text-center text-xs text-ink-400">
              会读取照片里的拍摄地点和时间，自动生成足迹。支持 JPG / PNG / HEIC
            </span>
          )}
        </button>
      ) : (
        <div className="rounded-2xl bg-white p-3 shadow-card">
          <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
            {items.map((p, i) => (
              <div key={i} className="relative aspect-square overflow-hidden rounded-lg bg-ink-100">
                <img src={p.previewUrl} alt="" className="size-full object-cover" />
                {p.lng != null && (
                  <span className="absolute right-1 bottom-1 rounded-full bg-emerald-500 p-0.5 text-white">
                    <MapPin className="size-2.5" />
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-600">
            共 {items.length} 张，其中 <b className="text-emerald-600">{withGps}</b> 张带位置信息
          </p>
          {withGps < items.length && isIOS() && (
            <p className="mt-1 text-xs text-ink-400">提示：iPhone 选择照片时点右上「选项」并打开「位置」，才能保留地点信息。</p>
          )}
          <div className="mt-3">
            <Switch checked={auto} onChange={setAuto} label="根据照片位置自动生成打卡点（300 米内自动合并）" />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={!!uploading} onClick={() => setItems([])}>
              取消
            </Button>
            <Button size="sm" loading={!!uploading} icon={<Upload className="size-4" />} onClick={upload}>
              {uploading ? `上传中 ${uploading.done}/${uploading.total}` : `上传 ${items.length} 张`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
