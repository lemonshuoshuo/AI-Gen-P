import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Footprints, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripDetail } from '@/api'
import { Button, Spinner, confirmDialog } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { fmtTime } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { dropTrackBuffer } from '@/hooks/useGeoTracker'

/** GPS 轨迹：导入 GPX 文件、清空轨迹 */
export function TrackPanel({ trip }: { trip: TripDetail }) {
  const qc = useQueryClient()
  const { data: site } = useSite()
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)
  // 只要统计信息：max=10 只取很少的点（['track', id] 缓存的是地图用的 2000 点，不共用）
  const summary = useQuery({ queryKey: ['track-summary', trip.id], queryFn: () => api.trips.track(trip.id, 10) })
  const t = summary.data
  const busy = progress != null || clearing

  // 轨迹变化影响地图上的轨迹、旅程里程（卡片、个人统计）和计划 vs 实际
  const changed = () => {
    qc.invalidateQueries({ queryKey: ['track', trip.id] })
    qc.invalidateQueries({ queryKey: ['track-summary', trip.id] })
    qc.invalidateQueries({ queryKey: ['trip', String(trip.id)] })
    qc.invalidateQueries({ queryKey: ['compare', String(trip.id)] })
    invalidateTripLists(qc)
  }

  const importGpx = async (file: File | undefined) => {
    if (!file) return
    const maxMb = site?.upload.max_photo_mb
    if (maxMb && file.size > maxMb * 1024 * 1024) return toast.error(`文件不能超过 ${maxMb} MB`)
    setProgress(0)
    try {
      const r = await api.trips.importTrack(trip.id, file, setProgress)
      if (r.accepted > 0) toast.success(`已导入 ${r.accepted} 个轨迹点（${r.segments} 段），轨迹里程约 ${formatKm(r.distance_km)}`)
      else toast('这个文件里的轨迹之前已经导入过了')
      changed()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setProgress(null)
    }
  }

  const clear = async () => {
    const ok = await confirmDialog({
      title: '清空这段旅程的 GPS 轨迹？',
      desc: '所有成员记录和导入的轨迹都会被删除，无法恢复；打卡点和照片不受影响。',
      danger: true,
      okText: '清空',
    })
    if (!ok) return
    setClearing(true)
    try {
      await api.trips.clearTrack(trip.id)
      // 本机还没上传的轨迹点（旅行模式离线时记下的）也丢掉，否则下次打开旅行模式会把清空前的轨迹又传上去
      dropTrackBuffer(trip.id)
      toast.success('已清空轨迹')
      changed()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setClearing(false)
    }
  }

  const km = formatKm(t?.distance_km)
  return (
    <div className="space-y-8">
      <div className="border-t border-ink-200 pt-3.5">
        <p className="eyebrow flex items-center gap-2 !text-ink-900">
          <Footprints className="size-3.5" strokeWidth={1.5} />
          GPS Track · 轨迹
        </p>
        <div className="mt-6 min-h-12">
          {summary.isLoading ? (
            <Spinner className="size-4" />
          ) : summary.isError && !t ? (
            <p className="text-sm text-ink-500">
              轨迹信息加载失败，
              <button type="button" onClick={() => summary.refetch()} className="text-brand-600 underline-offset-2 hover:underline">
                重试
              </button>
            </p>
          ) : t && t.point_count > 0 ? (
            <>
              <div className="grid grid-cols-2 divide-x divide-ink-200 border-b border-ink-200 pb-6">
                <div className="pr-5">
                  <p className="eyebrow">Distance · 轨迹里程</p>
                  <span className="font-num mt-4 inline-block text-[3.5rem] leading-[0.85] font-light tracking-tight text-ink-900">
                    {km.split(' ')[0]}
                  </span>
                  <span className="ml-1.5 text-xs text-ink-500">{km.split(' ')[1]}</span>
                </div>
                <div className="pl-5">
                  <p className="eyebrow">Points · 轨迹点</p>
                  <span className="font-num mt-4 inline-block text-[3.5rem] leading-[0.85] font-light tracking-tight text-ink-900">
                    {t.point_count.toLocaleString()}
                  </span>
                </div>
              </div>
              {t.started_at && (
                <p className="font-num mt-4 text-[14px] tracking-wide text-ink-500">
                  {fmtTime(t.started_at)} – {fmtTime(t.ended_at)}
                </p>
              )}
            </>
          ) : (
            <p className="font-display text-[19px] leading-[1.6] text-ink-600">
              还没有 GPS 轨迹。出发后旅行模式会自动记录，也可以导入运动手表或户外 App 导出的 GPX 文件。
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <input
          ref={input}
          type="file"
          accept=".gpx,application/gpx+xml"
          hidden
          onChange={(e) => {
            importGpx(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button
          block
          variant="outline"
          loading={progress != null}
          disabled={busy}
          icon={<Upload className="size-4" strokeWidth={1.5} />}
          onClick={() => input.current?.click()}
        >
          {progress != null ? `导入中 ${Math.round(progress * 100)}%` : '导入 GPX 轨迹'}
        </Button>
        <p className="pt-1 text-xs leading-relaxed text-ink-500">
          支持两步路、六只脚、运动手表等导出的 GPX 文件（最多 5 万个点，需带时间）；重复导入同一文件不会产生重复的点；导入不会改变旅程状态
        </p>
      </div>

      {t && t.point_count > 0 && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-brand-600 hover:bg-brand-50"
            loading={clearing}
            disabled={busy}
            icon={<Trash2 className="size-4" strokeWidth={1.5} />}
            onClick={clear}
          >
            清空轨迹
          </Button>
        </div>
      )}
    </div>
  )
}
