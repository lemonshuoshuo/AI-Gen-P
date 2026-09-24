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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-card">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <Footprints className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          {summary.isLoading ? (
            <Spinner className="size-4" />
          ) : summary.isError && !t ? (
            <p className="text-sm text-ink-500">
              轨迹信息加载失败，
              <button type="button" onClick={() => summary.refetch()} className="text-brand-600 hover:underline">
                重试
              </button>
            </p>
          ) : t && t.point_count > 0 ? (
            <>
              <p className="text-sm font-medium text-ink-900">
                已记录 {t.point_count} 个轨迹点 · 约 {formatKm(t.distance_km)}
              </p>
              {t.started_at && (
                <p className="mt-0.5 text-xs text-ink-400">
                  {fmtTime(t.started_at)} – {fmtTime(t.ended_at)}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-500">还没有 GPS 轨迹</p>
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
          icon={<Upload className="size-4" />}
          onClick={() => input.current?.click()}
        >
          {progress != null ? `导入中 ${Math.round(progress * 100)}%` : '导入 GPX 轨迹'}
        </Button>
        <p className="text-xs leading-relaxed text-ink-400">
          支持两步路、六只脚、运动手表等导出的 GPX 文件（最多 5 万个点，需带时间）；重复导入同一文件不会产生重复的点；导入不会改变旅程状态
        </p>
      </div>

      {t && t.point_count > 0 && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:bg-red-50"
            loading={clearing}
            disabled={busy}
            icon={<Trash2 className="size-4" />}
            onClick={clear}
          >
            清空轨迹
          </Button>
        </div>
      )}
    </div>
  )
}
