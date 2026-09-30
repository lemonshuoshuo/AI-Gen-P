import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, Bed, CloudUpload, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { errorMessage, type ArrangeScope, type TravelMode, type TripDetail, type Waypoint } from '@/api'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteSegments } from '@/components/map/layers'
import { PlanMarkers, planMarkerItems } from '@/components/trip/PlanMarkers'
import { dayTone, groupPlan, isLodging, plannedSegments, stopLabels } from '@/components/trip/plan'
import { Button, Modal } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fmtMinutes } from '@/lib/format'
import { formatDistance } from '@/lib/geo'
import { ChoiceChip, Stepper } from './Choice'
import { TravelModePicker } from './RouteLegs'
import { IndeterminateLine } from './Indeterminate'
import { usePlanEditorCtx } from './usePlanEditor'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 日期跨度（天），没有日期为 0 */
function dateSpan(t: TripDetail) {
  if (!t.start_date || !t.end_date) return 0
  return dayjs(t.end_date).diff(dayjs(t.start_date), 'day') + 1
}

/**
 * 一键排好路线：把「想去」的地点分到各天、每天排出最顺的顺序。先出方案预览（地图 + 每天的清单和路程），
 * 确认后才保存；可以只排「想去」（已安排好的天保持不变），也可以重新排全部没去过的地点
 */
export function ArrangeDialog({
  trip,
  open,
  onClose,
  onApplied,
  initialScope,
}: {
  trip: TripDetail
  open: boolean
  onClose: () => void
  onApplied: () => void
  initialScope?: ArrangeScope
}) {
  const editor = usePlanEditorCtx()
  const groups = useMemo(() => groupPlan(trip.waypoints, trip.days), [trip])
  const span = dateSpan(trip)
  const pool = groups.pool.filter((w) => w.planned)
  const suggested = Math.max(1, Math.ceil((pool.length + groups.days.reduce((n, d) => n + d.stops.length, 0)) / 5))
  const [scope, setScope] = useState<ArrangeScope>(pool.length ? (initialScope ?? 'pool') : 'all')
  const [mode, setMode] = useState<TravelMode>(trip.travel_mode || 'auto')
  const [days, setDays] = useState(() => groups.dayCount || suggested)
  const [applying, setApplying] = useState(false)
  const maxDays = span || 60

  // 方案由服务端按已保存的计划计算：地点、天数有未保存的修改时先保存
  const needSave = editor.structureDirty
  const [savingFirst, setSavingFirst] = useState(false)
  const q = useQuery({
    queryKey: ['arrange-preview', trip.id, trip.revision, scope, mode, days, trip.waypoints.map((w) => `${w.id}:${w.day}:${w.seq}`).join(',')],
    queryFn: () => editor.previewArrangement({ scope, mode, days }),
    enabled: open && !needSave,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  })
  const r = q.data

  // 方案里的新位置套到现有的打卡点上：地图和清单都按它显示
  const preview = useMemo(() => {
    if (!r) return null
    const pos = new Map(r.items.map((i) => [i.id, i]))
    const wps: Waypoint[] = trip.waypoints.map((w) => {
      const p = pos.get(w.id)
      return p ? { ...w, day: p.day, seq: p.seq } : w
    })
    const g = groupPlan(wps, r.days)
    return { g, labels: stopLabels(g), byId: new Map(wps.map((w) => [w.id, w])) }
  }, [r, trip.waypoints])
  const segments = useMemo(
    () => (preview ? plannedSegments(preview.g, undefined, { icons: false }).map((s) => ({ ...s, estimated: false })) : []),
    [preview],
  )
  const markers = useMemo(() => (preview ? planMarkerItems(preview.g, preview.labels, { hidePool: false }) : []), [preview])
  const pts = useMemo(() => markers.map((m) => [m.w.lng, m.w.lat] as [number, number]), [markers])

  const apply = () => {
    if (!r) return
    setApplying(true)
    try {
      editor.applyArrangement(r)
      toast.success(`已按方案排好 ${r.days} 天的路线`, { description: '还没保存：可以继续拖动调整，确认后点「保存」' })
      onApplied()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setApplying(false)
    }
  }
  const saveFirst = async () => {
    setSavingFirst(true)
    try {
      await editor.save()
    } finally {
      setSavingFirst(false)
    }
  }

  const leftover = preview ? preview.g.pool.filter((w) => w.planned && !isLodging(w)).length : 0
  // 换了天的地点数（服务端的 changed 还包括只是 seq 编号变了的点）
  const moved = r ? r.items.filter((i) => trip.waypoints.find((w) => w.id === i.id)?.day !== i.day).length : 0

  return (
    <Modal
      open={open}
      onClose={() => !applying && onClose()}
      wide
      title={
        <span className="inline-flex items-center gap-2 text-[22px]">
          <Sparkles className="size-5 text-brand-500" strokeWidth={1.5} />
          一键排好路线
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button
            variant="accent"
            loading={applying}
            disabled={needSave || !r || q.isFetching || q.isError || r.changed === 0}
            onClick={apply}
            icon={!applying ? <ArrowRight className="size-4" strokeWidth={1.5} /> : undefined}
          >
            {r && r.changed === 0 ? '已经是这样排的了' : '就这样安排'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-xs tracking-[0.06em] text-ink-500">排哪些地点</p>
            <div role="radiogroup" aria-label="排哪些地点" className="flex flex-wrap gap-1.5">
              <ChoiceChip selected={scope === 'pool'} onClick={() => setScope('pool')} disabled={!pool.length} size="sm">
                只排「想去」的 {pool.length} 个
              </ChoiceChip>
              <ChoiceChip selected={scope === 'all'} onClick={() => setScope('all')} size="sm">
                重新排全部没去过的
              </ChoiceChip>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
              {scope === 'pool' ? '已经安排到某天的地点保持不动，新地点插到各天最顺路的位置' : '按位置重新分组，每天从前一晚的住宿出发、回到当晚的住宿'}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <p className="mb-2 text-xs tracking-[0.06em] text-ink-500">分成几天</p>
              <Stepper value={days} min={1} max={maxDays} onChange={setDays} unit="天" label="天数" />
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-xs tracking-[0.06em] text-ink-500">怎么走（只用来估算路程，不改旅程的出行方式）</p>
              <TravelModePicker value={mode} onChange={setMode} />
            </div>
          </div>
          {span > 0 && <p className="text-[11.5px] text-ink-400">旅程设置了日期，最多 {span} 天</p>}
        </div>

        {needSave && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand-300 bg-brand-50 px-3.5 py-3 text-[13px] text-ink-900">
            <CloudUpload className="size-4 shrink-0 text-brand-600" strokeWidth={1.5} />
            <p className="min-w-0 flex-1 leading-relaxed">
              一键排路线按已保存的计划计算。你刚才改了地点或天数，先保存这些修改再看方案。
            </p>
            <Button size="sm" onClick={saveFirst} loading={savingFirst || editor.saving}>
              保存并预览
            </Button>
          </div>
        )}
        <div className="border-t border-ink-200 pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow !text-ink-900">Preview · 方案预览</p>
            {r && (
              <span className="caption !text-xs">
                {moved > 0 ? (
                  <>
                    <span className="font-num text-[14px] text-ink-900">{moved}</span> 个地点会分到新的一天{r.changed > moved ? '，顺序也会调整' : ''}
                  </>
                ) : r.changed > 0 ? (
                  '会调整每天的先后顺序'
                ) : (
                  '和现在的安排一样'
                )}
              </span>
            )}
          </div>
          {q.isFetching ? <IndeterminateLine className="mt-3" label="正在计算方案" /> : <div className="mt-3 h-[2px]" />}
          {q.isError && <p className="mt-3 text-sm text-brand-600">{errorMessage(q.error)}</p>}
          {preview && r && (
            <div className={cn('mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]', q.isFetching && 'opacity-60')}>
              <div className="-mx-6 overflow-hidden border-y border-ink-200 md:mx-0 md:rounded-sm md:border-0 md:ring-1 md:ring-ink-200">
                <BaseMap className="h-56 md:h-[22rem]" navigation={false}>
                  <RouteSegments segments={segments} idPrefix="arrange" icons={false} />
                  <PlanMarkers items={markers} />
                  <FitOnce points={pts} fitKey={`arr-${r.days}-${pts.length}`} padding={36} />
                </BaseMap>
              </div>
              <ol className="max-h-[22rem] space-y-4 overflow-y-auto pr-1">
                {r.day_totals.map((d) => {
                  const tone = dayTone(d.day)
                  const start = d.start_lodging_id ? preview.byId.get(d.start_lodging_id) : null
                  const end = d.end_lodging_id ? preview.byId.get(d.end_lodging_id) : null
                  const stops = d.ids.map((id) => preview.byId.get(id)).filter((w): w is Waypoint => !!w)
                  return (
                    <li key={d.day}>
                      <div className="flex items-baseline gap-2.5 border-b border-ink-200 pb-1.5">
                        <span className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', tone.bg)} aria-hidden />
                        <span className="eyebrow !text-ink-900">Day {pad2(d.day)}</span>
                        <span className="caption ml-auto !text-[11.5px]">
                          {d.stops} 站
                          {d.stops > 0 && (
                            <>
                              {' · '}约 <span className="font-num text-[13px] text-ink-900">{fmtMinutes(d.duration_s)}</span> · {formatDistance(d.distance_m)}
                            </>
                          )}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-[1.9] text-ink-700">
                        {start && (
                          <span className="text-ink-500">
                            <Bed className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={1.5} />
                            {start.name}
                            <span className="mx-1.5 text-ink-300">→</span>
                          </span>
                        )}
                        {stops.length ? (
                          stops.map((w, i) => (
                            <span key={w.id}>
                              {i > 0 && <span className="mx-1.5 text-ink-300">→</span>}
                              <span className="font-num text-[12px] text-ink-400">{i + 1}.</span>
                              {w.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-ink-400">这天没有安排地点</span>
                        )}
                        {end && (
                          <span className="text-ink-500">
                            <span className="mx-1.5 text-ink-300">→</span>
                            <Bed className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={1.5} />
                            {end.name}
                          </span>
                        )}
                      </p>
                    </li>
                  )
                })}
                {leftover > 0 && <li className="caption !text-xs">还有 {leftover} 个地点留在「想去」</li>}
              </ol>
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
            预览按直线估算路程。「就这样安排」后还要点「保存」才会生效，保存后按实际道路重新计算，也可以再手动调整。
          </p>
        </div>
      </div>
    </Modal>
  )
}
