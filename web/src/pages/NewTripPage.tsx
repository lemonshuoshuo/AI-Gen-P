import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Heart, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, type AIPlanItem, type AIPlanProgress, type AIPlanResult, type Phase } from '@/api'
import { IndeterminateLine } from '@/components/editor/Indeterminate'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines } from '@/components/map/layers'
import { Button, CategoryChip, Field, Input, Switch, Textarea } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { isAdmin, useAuth } from '@/stores/auth'

type Mode = 'plan' | 'ai' | 'photos'

const modes: { value: Mode; title: string; en: string; desc: string }[] = [
  { value: 'plan', title: '自己规划路线', en: 'Plan', desc: '搜索地点、排好顺序，出发时按图打卡' },
  { value: 'ai', title: 'AI 帮我规划', en: 'Assisted', desc: '告诉 AI 目的地和喜好，自动写出每天的行程' },
  { value: 'photos', title: '已经玩回来了', en: 'Afterwards', desc: '上传照片，按拍摄地点自动生成足迹' },
]

const pad2 = (n: number) => String(n).padStart(2, '0')

// 坐标来源：located 为高德搜索校正，place_id 为社区已有地点；两者皆否但有坐标时是 AI 估算的，未经校验
const hasCoord = (i: AIPlanItem) => i.lng != null && i.lat != null
const isVerified = (i: AIPlanItem) => hasCoord(i) && (i.located || i.place_id != null)
const isEstimated = (i: AIPlanItem) => hasCoord(i) && !isVerified(i)

type Stage = AIPlanProgress['stage']
const stages: { key: Stage; label: string; title: string; hint: string }[] = [
  { key: 'thinking', label: '思考', title: '思考中', hint: '在构思路线：去哪些地方、先后顺序、每天的节奏' },
  { key: 'writing', label: '书写', title: '正在书写行程', hint: '逐日写下景点、美食和注意事项' },
  { key: 'locating', label: '校准', title: '正在校准地点坐标', hint: '用地图服务核对每个地点的真实位置' },
]

interface Run {
  stage: Stage
  chars: number
  message: string
  started: number
  /** 服务端没有流式接口（旧版本）：只能等整份结果，没有字数进度 */
  legacy?: boolean
}

/** 区块头：一条细线，下面一行小字（左侧标签 + 灰色说明，右侧补充） */
function LabelRow({ eyebrow, note, aside, className }: { eyebrow: string; note?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 border-t border-ink-200 pt-4', className)}>
      <p className="flex min-w-0 items-baseline gap-4">
        <span className="eyebrow !text-ink-900">{eyebrow}</span>
        {note && <span className="caption truncate">{note}</span>}
      </p>
      {aside && <div className="caption shrink-0">{aside}</div>}
    </div>
  )
}

/** 大号标题式输入框：只有一条底线，宋体大字 */
const underline = 'h-16 rounded-none border-0 border-b border-ink-300 bg-transparent px-0 hover:border-ink-500 focus:border-ink-900 md:h-20'
const bigInput = `${underline} font-display text-[26px] md:text-[36px]`
const bigNumInput = `${underline} font-num text-[34px] font-light md:text-[46px]`

/** 生成中的进度：阶段、实时字数、用时，一条细线动画，可取消 */
function PlanProgress({ run, onCancel }: { run: Run; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - run.started) / 1000))
  const idx = stages.findIndex((s) => s.key === run.stage)
  const cur = stages[Math.max(0, idx)]
  const slow = elapsed >= 45 && run.stage !== 'locating'
  return (
    <section className="animate-fade-in" aria-live="polite" aria-busy="true">
      <LabelRow
        eyebrow="AI Planning · 生成中"
        aside={
          <ol className="flex items-center gap-4 text-[11px] tracking-wide" aria-label="生成步骤">
            {stages.map((s, i) => {
              const done = i < idx
              const on = i === idx
              return (
                <li key={s.key} className={cn('flex items-center gap-1.5', on ? 'text-ink-900' : done ? 'text-ink-500' : 'text-ink-400')}>
                  <span
                    className={cn(
                      'font-num flex size-4 items-center justify-center rounded-full text-[10px] leading-none',
                      on ? 'bg-brand-500 text-white' : done ? 'bg-ink-900 text-paper' : 'border border-ink-300',
                    )}
                  >
                    {done ? <Check className="size-2.5" strokeWidth={2} /> : i + 1}
                  </span>
                  <span className="hidden sm:inline">{s.label}</span>
                </li>
              )
            })}
          </ol>
        }
      />
      <p className="text-display-md mt-10 text-ink-900">{cur.title}</p>
      <p className="mt-3 min-h-5 text-[14px] leading-relaxed text-ink-500">
        {run.legacy ? '一份多日行程通常需要 20–60 秒，请稍候' : run.message || cur.hint}
      </p>
      <IndeterminateLine className="mt-10" label="AI 正在生成行程" />
      <div className="mt-8 flex items-end justify-between gap-4">
        <div className="flex divide-x divide-ink-200">
          {!run.legacy && (
            <div className="pr-8">
              <p className="eyebrow">Characters · 已写字数</p>
              <div className="font-num mt-4 text-[3.5rem] leading-[0.85] font-light tracking-tight text-ink-900 tabular-nums md:text-[4.5rem]">
                {run.chars.toLocaleString()}
              </div>
            </div>
          )}
          <div className={cn(!run.legacy && 'pl-8')}>
            <p className="eyebrow">Elapsed · 已用时</p>
            <div className="font-num mt-4 text-[3.5rem] leading-[0.85] font-light tracking-tight text-ink-900 tabular-nums md:text-[4.5rem]">
              {elapsed}
              <span className="ml-1.5 font-sans text-xs text-ink-500">秒</span>
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
      </div>
      {slow && (
        <p className="mt-8 border-t border-ink-200 pt-4 text-xs leading-relaxed text-ink-500">
          这次想得有点久。可以继续等待；也可以取消后减少天数、把要求写得更简短再试。
        </p>
      )}
    </section>
  )
}

function AIPlanner({
  onUse,
  amapSearch,
}: {
  onUse: (r: AIPlanResult, items: AIPlanItem[], days: number, startDate: string) => Promise<void>
  /** 服务器配置了高德 Key：没配置时所有地点都无法校正，默认也加入 AI 估算的位置 */
  amapSearch: boolean
}) {
  const [f, setF] = useState({ destination: '', days: 2, preferences: '', start_date: '' })
  const [result, setResult] = useState<AIPlanResult | null>(null)
  const [using, setUsing] = useState(false)
  const [withEst, setWithEst] = useState<boolean | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const includeEst = withEst ?? !amapSearch

  // 离开页面时停止生成
  useEffect(() => () => abortRef.current?.abort(), [])

  const generate = async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setError(null)
    setRun({ stage: 'thinking', chars: 0, message: '', started: Date.now() })
    const body = {
      destination: f.destination.trim(),
      days: f.days,
      preferences: f.preferences.trim() || undefined,
      start_date: f.start_date || undefined,
    }
    try {
      let r: AIPlanResult
      try {
        r = await api.ai.planStream(
          body,
          (p) => {
            if (!ac.signal.aborted) setRun((x) => (x ? { ...x, stage: p.stage, chars: p.chars, message: p.message } : x))
          },
          ac.signal,
        )
      } catch (e) {
        // 旧版服务端没有流式接口：退回普通接口（没有进度，取消时丢弃结果）
        if (!(e instanceof ApiError && e.status === 404)) throw e
        setRun((x) => (x ? { ...x, legacy: true } : x))
        r = await api.ai.plan(body)
      }
      if (ac.signal.aborted) return
      setResult(r)
      setWithEst(null)
    } catch (e) {
      if (ac.signal.aborted || (e as Error).name === 'AbortError') return
      setError(errorMessage(e))
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null
        setRun(null)
      }
    }
  }
  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRun(null)
  }

  // 会加入路线的地点：预览地图与保存用同一份
  const toSave = useMemo(
    () => (result?.items ?? []).filter((i) => isVerified(i) || (includeEst && isEstimated(i))),
    [result, includeEst],
  )
  const located = useMemo(() => toSave.map((i) => [i.lng!, i.lat!] as [number, number]), [toSave])
  const estCount = (result?.items ?? []).filter(isEstimated).length
  const days = [...new Set((result?.items ?? []).map((i) => i.day))].sort((a, b) => a - b)
  const busy = !!run

  return (
    <div className="space-y-20 md:space-y-28">
      <div className="space-y-8">
        <fieldset disabled={busy} className="space-y-8 disabled:opacity-60">
          <div className="grid grid-cols-[1fr_5.5rem] gap-x-6 md:grid-cols-[1fr_8rem] md:gap-x-10">
            <Field label="去哪儿">
              <Input
                value={f.destination}
                onChange={(e) => setF({ ...f, destination: e.target.value })}
                maxLength={30}
                placeholder="如：台州、成都+重庆、大理"
                className={bigInput}
              />
            </Field>
            <Field label="玩几天">
              <Input
                type="number"
                min={1}
                max={15}
                value={f.days}
                onChange={(e) => setF({ ...f, days: Math.min(15, Math.max(1, Number(e.target.value) || 1)) })}
                className={bigNumInput}
              />
            </Field>
          </div>
          <Field label="出发日期（可选）" className="max-w-xs">
            <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} className="h-12" />
          </Field>
          <Field label="偏好和要求" hint="越具体越好：同行人、节奏、预算、爱吃什么、想拍照还是躺平">
            <Textarea
              value={f.preferences}
              onChange={(e) => setF({ ...f, preferences: e.target.value })}
              maxLength={300}
              placeholder="情侣出游，想吃本地特色小吃，喜欢拍照，不想太累，预算中等，避开网红坑"
              className="min-h-28 text-[15px] leading-[1.8]"
            />
          </Field>
        </fieldset>
        {!busy && (
          <Button
            size="lg"
            className="w-full sm:w-auto sm:min-w-56"
            variant={result ? 'outline' : 'accent'}
            disabled={!f.destination.trim()}
            onClick={generate}
          >
            {result ? '重新生成' : '生成行程'}
            <ArrowRight className="size-4" strokeWidth={1.5} />
          </Button>
        )}
        {error && !busy && (
          <div role="alert" className="flex gap-3 border-l border-brand-500 py-1 pl-4 text-sm leading-relaxed text-ink-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-brand-600" strokeWidth={1.5} />
            <span className="min-w-0 flex-1">
              <span className="text-ink-900">没能生成行程：</span>
              {error}
            </span>
          </div>
        )}
      </div>

      {run && <PlanProgress run={run} onCancel={cancel} />}

      {result && !run && (
        <section className="animate-slide-up">
          <LabelRow eyebrow="Draft · AI 行程草稿" note={`${result.items.length} 个地点`} aside={`${days.length} 天`} />
          <h2 className="text-display-lg mt-10 text-ink-900 md:mt-14">{result.title}</h2>
          {result.summary && <p className="mt-6 max-w-2xl text-[15px] leading-[1.9] text-ink-500">{result.summary}</p>}
          {located.length > 0 && (
            <div className="mt-12 overflow-hidden rounded-sm ring-1 ring-ink-200">
              <BaseMap className="h-72 md:h-96" navigation={false}>
                <RouteLines planned={located} idPrefix="ai" />
                <FitOnce points={located} fitKey={result.title + toSave.length} />
              </BaseMap>
            </div>
          )}
          <div className="mt-16 space-y-16 md:mt-20 md:space-y-20">
            {days.map((d) => {
              const list = result.items.filter((i) => i.day === d)
              return (
                <div key={d}>
                  <div className="flex items-end gap-5 border-b border-ink-200 pb-5">
                    <span className="font-num text-[4rem] leading-[0.74] font-light tracking-[-0.02em] text-ink-900 md:text-[5rem]">
                      {pad2(d)}
                    </span>
                    <div className="min-w-0 pb-0.5 text-[13px] leading-[1.45]">
                      <p className="text-ink-900">
                        <span className="eyebrow !text-ink-900">Day {pad2(d)}</span>
                        {f.start_date && <span className="ml-3">{dayjs(f.start_date).add(d - 1, 'day').format('M月D日')}</span>}
                      </p>
                      <p className="text-ink-500">{f.start_date ? dayjs(f.start_date).add(d - 1, 'day').format('dddd') : `第 ${d} 天`}</p>
                    </div>
                    <span className="caption ml-auto shrink-0 pb-0.5">
                      <span className="font-num text-[14px]">{list.length}</span> 个地点
                    </span>
                  </div>
                  <ol className="divide-y divide-ink-200">
                    {list.map((i, idx) => {
                      const est = isEstimated(i)
                      const none = !hasCoord(i)
                      return (
                        <li key={idx} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 py-7 md:grid-cols-[3rem_minmax(0,1fr)] md:gap-x-6 md:py-9">
                          <span
                            className={cn(
                              'font-num mt-1 flex size-8 items-center justify-center rounded-full text-sm leading-none',
                              none
                                ? 'border border-ink-300 text-ink-400'
                                : est
                                  ? 'border border-dashed border-amber-500 text-amber-700'
                                  : 'bg-ink-900 text-paper',
                            )}
                            title={none ? '未找到位置' : est ? 'AI 估算位置' : '已校准位置'}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              <CategoryChip category={i.category} />
                              {est && (
                                <span className="inline-flex items-center gap-1 tracking-wide text-amber-700">
                                  <TriangleAlert className="size-3" strokeWidth={1.5} />
                                  AI 估算位置
                                </span>
                              )}
                              {none && <span className="tracking-wide text-ink-500">未找到位置</span>}
                            </div>
                            <p className={cn('font-display mt-2.5 text-[24px] leading-[1.2] md:text-[30px]', none ? 'text-ink-500' : 'text-ink-900')}>
                              {i.name}
                            </p>
                            {i.address && <p className="caption mt-1.5">{i.address}</p>}
                            {i.note && <p className="mt-4 max-w-xl text-[14.5px] leading-[1.85] text-ink-500">{i.note}</p>}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )
            })}
            {estCount > 0 && (
              <div className="space-y-2 border-l border-amber-500 py-1 pl-4">
                <Switch checked={includeEst} onChange={setWithEst} label={`同时加入 ${estCount} 个 AI 估算位置的地点`} />
                <p className="text-xs leading-relaxed text-ink-500">
                  这些坐标未经地图服务校正，可能偏差几百米甚至几公里，加入后请在编辑页拖动标记核对
                </p>
              </div>
            )}
            <div className="border-t border-ink-200 pt-8">
              <Button
                size="lg"
                variant="accent"
                className="w-full sm:w-auto sm:min-w-64"
                loading={using}
                icon={<Check className="size-4" strokeWidth={1.5} />}
                onClick={async () => {
                  setUsing(true)
                  try {
                    await onUse(result, toSave, f.days, f.start_date)
                  } finally {
                    setUsing(false)
                  }
                }}
              >
                就按这个来，创建旅程
              </Button>
              <p className="mt-4 max-w-md text-xs leading-relaxed text-ink-500">
                创建后可以在编辑页继续调整；未加入路线的地点可以在编辑页搜索后手动添加
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default function NewTripPage() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const user = useAuth((s) => s.user)
  const { data: site } = useSite()
  const [mode, setMode] = useState<Mode>(params.get('ai') ? 'ai' : 'plan')
  const qc = useQueryClient()
  const [f, setF] = useState({ title: '', start_date: '', end_date: '', with_partner: !!user?.partner })
  const [creating, setCreating] = useState(false)
  // AI 规划：路线没保存成功、刚建的旅程也没删掉时记下来，重试前先删，避免留下空旅程
  const orphanTrip = useRef<number | null>(null)
  // 进入页面后才刷新到的情侣绑定（或刚解除绑定）：同步「和 TA 一起」的默认值
  const partnerId = user?.partner?.id
  useEffect(() => {
    setF((p) => ({ ...p, with_partner: !!partnerId }))
  }, [partnerId])

  const create = async () => {
    if (!f.title.trim()) return toast.error('给旅程起个名字吧')
    setCreating(true)
    try {
      const phase: Phase = mode === 'photos' ? 'finished' : 'planning'
      const t = await api.trips.create({
        title: f.title.trim(),
        start_date: f.start_date || null,
        end_date: f.end_date || null,
        phase,
        with_partner: f.with_partner && !!user?.partner,
      })
      invalidateTripLists(qc)
      nav(`/trips/${t.id}/edit${mode === 'photos' ? '?panel=photos' : ''}`, { replace: true })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  // picked：AIPlanner 挑出的要加入路线的地点（都有坐标）
  const useAIPlan = async (r: AIPlanResult, picked: AIPlanItem[], days: number, startDate: string) => {
    let createdId: number | null = null
    try {
      if (orphanTrip.current != null) {
        const prev = orphanTrip.current
        orphanTrip.current = null
        await api.trips.remove(prev).catch(() => {})
      }
      const start = startDate || null
      const t = await api.trips.create({
        title: r.title || f.title || 'AI 规划的旅程',
        summary: r.summary,
        phase: 'planning',
        start_date: start,
        end_date: start ? dayjs(start).add(days - 1, 'day').format('YYYY-MM-DD') : null,
        with_partner: f.with_partner && !!user?.partner,
      })
      createdId = t.id
      invalidateTripLists(qc)
      const items = picked.map((i) => ({
        name: i.name,
        address: i.address,
        lng: i.lng!,
        lat: i.lat!,
        category: i.category,
        day: i.day,
        note: i.note,
        amap_id: i.amap_id || undefined,
        planned: true,
      }))
      if (items.length) await api.waypoints.batch(t.id, items)
      const left = r.items.length - items.length
      toast.success(left > 0 ? `已创建，${left} 个地点未加入路线，可在编辑页添加` : '已创建，可以继续调整路线')
      nav(`/trips/${t.id}/edit`, { replace: true })
    } catch (e) {
      toast.error(errorMessage(e))
      const id = createdId
      if (id != null) {
        // 路线没保存成功：删掉刚建的旅程（连同同行成员和通知），重试时重新创建，不会留下空旅程或重复的旅程
        await api.trips.remove(id).then(
          () => void invalidateTripLists(qc),
          () => {
            orphanTrip.current = id
          },
        )
      }
    }
  }

  const available = modes.filter((m) => m.value !== 'ai' || site?.ai_enabled)
  const current = available.find((m) => m.value === mode) ?? available[0]

  const partnerSwitch = user?.partner && (
    <Switch
      checked={f.with_partner}
      onChange={(v) => setF({ ...f, with_partner: v })}
      label={
        <span className="inline-flex items-center gap-2 text-[14px]">
          <Heart className="size-4 text-pink-500" strokeWidth={1.5} />和 {user.partner.nickname || user.partner.username} 一起
        </span>
      }
    />
  )

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 md:px-8 md:pt-24 md:pb-36">
      {/* 页头：超大标题 + 一句说明，不对称 */}
      <header className="grid gap-y-8 lg:grid-cols-12 lg:items-end lg:gap-x-8">
        <div className="lg:col-span-8">
          <p className="eyebrow animate-fade-in">New Journey · 新的旅程</p>
          <h1 className="text-display-xl animate-slide-up mt-6 text-ink-900 md:mt-8">
            这一次，
            <br />
            从哪里开始？
          </h1>
        </div>
        <p className="animate-fade-in max-w-sm text-[15px] leading-[1.8] text-ink-500 lg:col-span-3 lg:col-start-10 lg:pb-3">
          先定个方向，细节随时可以改。路线、照片和游记，都会慢慢长成一段完整的旅程。
        </p>
      </header>

      {/* 三种方式：大号编号 + 宋体标题的排版选项 */}
      <section className="mt-20 md:mt-32">
        <LabelRow eyebrow="Begin · 开始方式" note={`${available.length} 种方式`} aside="选一种" />
        <div role="radiogroup" aria-label="创建方式" className="mt-4 divide-y divide-ink-200 border-b border-ink-200">
          {available.map((m, i) => {
            const on = mode === m.value
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMode(m.value)}
                className="group grid w-full grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-x-4 py-7 text-left md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,18rem)_3rem] md:gap-x-8 md:py-10"
              >
                <span
                  className={cn(
                    'font-num text-[2.5rem] leading-none font-light tracking-[-0.02em] transition-colors duration-500 md:text-[4.5rem]',
                    on ? 'text-ink-900' : 'text-ink-300 group-hover:text-ink-500',
                  )}
                >
                  {pad2(i + 1)}
                </span>
                <span className="min-w-0">
                  <span className={cn('eyebrow block transition-colors duration-500', on && '!text-ink-700')}>{m.en}</span>
                  <span
                    className={cn(
                      'font-display mt-2 block text-[26px] leading-[1.15] transition-colors duration-500 md:mt-3 md:text-[48px]',
                      on ? 'text-ink-900' : 'text-ink-500 group-hover:text-ink-700',
                    )}
                  >
                    {m.title}
                  </span>
                  <span className="mt-2 block text-[13px] leading-relaxed text-ink-500 md:hidden">{m.desc}</span>
                </span>
                <span className="hidden text-[14px] leading-[1.8] text-ink-500 md:block">{m.desc}</span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-6 items-center justify-center justify-self-end rounded-full border transition-colors duration-500',
                    on ? 'border-ink-900' : 'border-ink-300 group-hover:border-ink-500',
                  )}
                >
                  <span className={cn('size-2.5 rounded-full bg-ink-900 transition-transform duration-500', on ? 'scale-100' : 'scale-0')} />
                </span>
              </button>
            )
          })}
        </div>
        {/* 面向管理员的配置提示：普通用户看不到，站点配置加载完之前也不显示 */}
        {site && !site.ai_enabled && isAdmin(user) && (
          <p className="mt-4 text-xs text-ink-500">提示：管理员在服务器配置 AI 模型后，可以使用「AI 帮我规划」和「智能推荐下一站」。</p>
        )}
      </section>

      {/* 细节：左侧标签，右侧表单 */}
      <section className="mt-20 md:mt-32">
        <LabelRow eyebrow="Details · 旅程信息" note={current ? `${pad2(available.indexOf(current) + 1)} · ${current.en}` : undefined} />
        <div className="mt-10 grid gap-y-10 md:mt-14 lg:grid-cols-12 lg:gap-x-8">
          <div className="lg:col-span-4">
            <p className="font-display text-[22px] leading-[1.5] text-ink-700 md:text-[26px]">
              {mode === 'plan' && '先起个名字，再慢慢把想去的地方排进路线。'}
              {mode === 'ai' && '说说去哪儿、玩几天和你的偏好，AI 会写出一份逐日的草稿。'}
              {mode === 'photos' && '把旅途中的照片交给我们，按拍摄地点和时间还原足迹。'}
            </p>
          </div>
          <div className="min-w-0 lg:col-span-7 lg:col-start-6">
            {mode !== 'ai' && (
              <div className="space-y-10" key={mode}>
                <Field label="旅程名称">
                  <Input
                    value={f.title}
                    onChange={(e) => setF({ ...f, title: e.target.value })}
                    placeholder={mode === 'photos' ? '如：2026 国庆 · 青甘大环线' : '如：五一杭州两日游'}
                    maxLength={80}
                    autoFocus
                    className={bigInput}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4 md:gap-6">
                  <Field label="开始日期">
                    <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} className="h-12" />
                  </Field>
                  <Field label="结束日期">
                    <Input
                      type="date"
                      value={f.end_date}
                      min={f.start_date}
                      onChange={(e) => setF({ ...f, end_date: e.target.value })}
                      className="h-12"
                    />
                  </Field>
                </div>
                {partnerSwitch}
                <div className="border-t border-ink-200 pt-8">
                  <Button size="lg" variant="accent" className="w-full sm:w-auto sm:min-w-64" loading={creating} onClick={create}>
                    {mode === 'photos' ? '创建并上传照片' : '创建并开始规划'}
                    {!creating && <ArrowRight className="size-4" strokeWidth={1.5} />}
                  </Button>
                </div>
              </div>
            )}
            {mode === 'ai' && (
              <div className="space-y-10">
                {partnerSwitch}
                <AIPlanner onUse={useAIPlan} amapSearch={site?.amap_search ?? true} />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
