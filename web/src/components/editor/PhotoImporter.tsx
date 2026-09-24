import { useEffect, useRef, useState } from 'react'
import { ImagePlus, MapPin, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import { Button, Switch } from '@/components/ui'
import { preparePhotos, type PreparedPhoto } from '@/lib/photo'
import { isIOS, isWeChat } from '@/lib/nav'

const MAX_BATCH = 100

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
  // 网格里是上次没有上传成功、留下来重试的照片
  const [retry, setRetry] = useState(false)
  // 离开页面 / 切换标签页时释放预览图（照片处理到一半就离开的也一样）
  const itemsRef = useRef(items)
  itemsRef.current = items
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      itemsRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl))
    }
  }, [])

  const pick = async (files: FileList | null) => {
    if (!files?.length) return
    const all = Array.from(files)
    const list = all.slice(0, MAX_BATCH)
    if (all.length > MAX_BATCH)
      toast.warning(`一次最多导入 ${MAX_BATCH} 张，已选取其中 ${MAX_BATCH} 张，其余 ${all.length - MAX_BATCH} 张请上传后再选`)
    setPreparing({ done: 0, total: list.length })
    const out = await preparePhotos(list, (done) => setPreparing({ done, total: list.length }))
    if (!alive.current) {
      out.forEach((p) => URL.revokeObjectURL(p.previewUrl))
      return
    }
    setPreparing(null)
    out.sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? ''))
    setItems(out)
    setRetry(false)
    if (out.length < list.length) toast.warning(`${list.length - out.length} 张照片无法读取，已跳过`)
  }

  const clear = () => {
    items.forEach((p) => URL.revokeObjectURL(p.previewUrl))
    setItems([])
    setRetry(false)
  }

  const removeOne = (p: PreparedPhoto) => {
    URL.revokeObjectURL(p.previewUrl)
    const left = items.filter((x) => x !== p)
    setItems(left)
    if (!left.length) setRetry(false)
  }

  const upload = async () => {
    const batch = items
    setUploading({ done: 0, total: batch.length })
    let created = 0
    let firstError = ''
    // 没有上传成功的照片留在网格里，可以重试（重新选整个相册会把已成功的照片再传一遍）
    const left: PreparedPhoto[] = []
    // 按拍摄时间顺序逐张上传，保证自动生成的打卡点顺序正确（重试时服务端也按时间插入）
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i]
      try {
        const r = await api.photos.upload(tripId, p.file, {
          filename: p.filename,
          lng: p.lng,
          lat: p.lat,
          coord_type: 'wgs84',
          taken_at: p.takenAt,
          // 浏览器没读出位置时也交给服务端：未经压缩的原图由服务端读取 EXIF（没有坐标时服务端会忽略）
          auto_waypoint: auto,
        })
        if (r.waypoint_created) created++
      } catch (e) {
        firstError ||= errorMessage(e)
        // 存储空间不足：后面的也传不上去，全部留下
        if (e instanceof Error && /配额|空间/.test(e.message)) {
          left.push(...batch.slice(i))
          break
        }
        left.push(p)
      }
      setUploading({ done: i + 1, total: batch.length })
    }
    const ok = batch.length - left.length
    batch.forEach((p) => !left.includes(p) && URL.revokeObjectURL(p.previewUrl))
    setItems(left)
    setRetry(left.length > 0)
    setUploading(null)
    const wp = created ? `，自动生成了 ${created} 个打卡点` : ''
    if (left.length === 0) toast.success(`上传完成${wp}`)
    else if (ok > 0) toast.warning(`已上传 ${ok} 张${wp}，还有 ${left.length} 张未上传：${firstError}`)
    else toast.error(`上传失败：${firstError}`)
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
              {isWeChat() && (
                <span className="mt-1 block text-amber-600">微信内选择的照片可能会被去掉位置信息，建议点右上角「···」选择「在浏览器打开」后再上传</span>
              )}
            </span>
          )}
        </button>
      ) : (
        <div className="rounded-2xl bg-white p-3 shadow-card">
          <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
            {items.map((p) => (
              <div key={p.previewUrl} className="relative aspect-square overflow-hidden rounded-lg bg-ink-100">
                <img src={p.previewUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                {p.lng != null && (
                  <span className="absolute right-1 bottom-1 rounded-full bg-emerald-500 p-0.5 text-white">
                    <MapPin className="size-2.5" />
                  </span>
                )}
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => removeOne(p)}
                    className="absolute top-0.5 right-0.5 rounded-full bg-black/50 p-0.5 text-white hover:bg-black/70"
                    aria-label="移除这张"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {retry ? (
            <p className="mt-3 text-sm text-amber-700">还有 {items.length} 张未上传成功，可重试或移除</p>
          ) : (
            <p className="mt-3 text-sm text-ink-600">
              共 {items.length} 张，其中 <b className="text-emerald-600">{withGps}</b> 张带位置信息
            </p>
          )}
          {withGps < items.length &&
            (isWeChat() ? (
              <p className="mt-1 text-xs text-ink-400">
                提示：微信内选择的照片可能会被去掉位置信息。点右上角「···」选择「在浏览器打开」后再上传，可保留拍摄地点。
              </p>
            ) : (
              isIOS() && <p className="mt-1 text-xs text-ink-400">提示：iPhone 选择照片时点右上「选项」并打开「位置」，才能保留地点信息。</p>
            ))}
          <div className="mt-3">
            <Switch checked={auto} onChange={setAuto} label="根据照片位置自动生成打卡点（300 米内自动合并）" />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={!!uploading} onClick={clear}>
              {retry ? '移除' : '取消'}
            </Button>
            <Button size="sm" loading={!!uploading} icon={<Upload className="size-4" />} onClick={upload}>
              {uploading ? `上传中 ${uploading.done}/${uploading.total}` : retry ? `重试 ${items.length} 张` : `上传 ${items.length} 张`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
