import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bed, Check, Heart, Loader2, MapPin, Sparkles, TriangleAlert, WandSparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  errorMessage,
  type AIPlanItem,
  type AIPlanProgress,
  type AIPlanResult,
  type AIPreferencesResult,
  type Phase,
  type Waypoint,
  type WaypointInput,
} from '@/api'
import { ChoiceCard, ChoiceChip, Stepper } from '@/components/editor/Choice'
import { ConfirmPlaceDialog, type ConfirmedPlace } from '@/components/editor/ConfirmPlaceDialog'
import { IndeterminateLine } from '@/components/editor/Indeterminate'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteSegments, type RouteSegment } from '@/components/map/layers'
import { PlanMarkers, type PlanMarkerItem } from '@/components/trip/PlanMarkers'
import { dayTone } from '@/components/trip/plan'
import { Button, CategoryChip, Field, Input, Switch, Textarea } from '@/components/ui'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { isAdmin, useAuth } from '@/stores/auth'

type Mode = 'plan' | 'ai' | 'photos'
type LngLat = [number, number]

const modes: { value: Mode; title: string; desc: string }[] = [
  { value: 'plan', title: '自己规划路线', desc: '按天安排想去的地方，一键排好顺序，出发时按图打卡' },
  { value: 'ai', title: 'AI 帮我规划', desc: '说说目的地和喜好，AI 写出每天的行程和住宿' },
  { value: 'photos', title: '已经玩回来了', desc: '上传照片，按拍摄地点和时间还原足迹' },
]

const pad2 = (n: number) => String(n).padStart(2, '0')

// 只有地图服务校正过的（located）才直接加入；其余（AI 估计的坐标、按名称匹配到的社区地点、没有坐标）都要用户在地图上确认，
// 不会被悄悄放在可能错误的位置上
const hasCoord = (i: AIPlanItem) => i.lng != null && i.lat != null
const isLodgingItem = (i: AIPlanItem) => i.kind === 'lodging'
// 住宿要是一家具体的酒店 / 民宿：AI 有时只写了「洱海」这样的地名，被定位到了湖上
const HOTELISH = /酒店|宾馆|饭店|民宿|客栈|旅馆|旅店|旅舍|青旅|公寓|度假|山庄|住宿|hotel|hostel|inn\b|resort|lodge|b&b/i
const isVerified = (i: AIPlanItem) => hasCoord(i) && i.located && (!isLodgingItem(i) || HOTELISH.test(i.name))

type Stage = AIPlanProgress['stage']
const stages: { key: Stage; label: string; title: string; hint: string }[] = [
  { key: 'thinking', label: '思考', title: '思考中', hint: '在构思路线：去哪些地方、先后顺序、每天的节奏' },
  { key: 'writing', label: '书写', title: '正在书写行程', hint: '逐日写下景点、美食、住宿和注意事项' },
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

const titleInput = 'font-display h-12 text-[17px] md:text-[18px]'
const dateInput = 'font-num h-11 text-[15px]'

/** 表单区：左 4 栏一句引导语，右 7 栏表单 */
function DetailGrid({ lead, children }: { lead: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-8 grid gap-y-8 md:mt-10 lg:grid-cols-12 lg:gap-x-8">
      <div className="lg:col-span-4">{lead}</div>
      <div className="min-w-0 lg:col-span-7 lg:col-start-6">{children}</div>
    </div>
  )
}

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
                      on ? 'bg-brand-500 text-paper' : done ? 'bg-ink-900 text-paper' : 'border border-ink-300',
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
      <p className="text-display-md mt-6 text-ink-900">{cur.title}</p>
      <p className="mt-2 min-h-5 text-[14px] leading-relaxed text-ink-500">
        {run.legacy ? '一份多日行程通常需要 20–60 秒，请稍候' : run.message || cur.hint}
      </p>
      <IndeterminateLine className="mt-6" label="AI 正在生成行程" />
      <div className="mt-6 flex items-end justify-between gap-4">
        <div className="flex divide-x divide-ink-200">
          {!run.legacy && (
            <div className="pr-6">
              <p className="eyebrow">Characters · 已写字数</p>
              <div className="font-num mt-3 text-[2.25rem] leading-[0.9] font-light text-ink-900 tabular-nums md:text-[2.75rem]">
                {run.chars.toLocaleString()}
              </div>
            </div>
          )}
          <div className={cn(!run.legacy && 'pl-6')}>
            <p className="eyebrow">Elapsed · 已用时</p>
            <div className="font-num mt-3 text-[2.25rem] leading-[0.9] font-light text-ink-900 tabular-nums md:text-[2.75rem]">
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
        <p className="mt-6 border-t border-ink-200 pt-4 text-xs leading-relaxed text-ink-500">
          这次想得有点久。可以继续等待；也可以取消后减少天数、把要求写得更简短再试。
        </p>
      )}
    </section>
  )
}

/** 「偏好和要求」：AI 帮写（建议短句可点选追加，也可以整段替换成 AI 整理好的文字） */
function PreferencesField({
  value,
  onChange,
  destination,
  days,
  startDate,
  together,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  destination: string
  days: number
  startDate: string
  together: boolean
  disabled?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<AIPreferencesResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const help = async () => {
    if (!destination.trim()) return toast('先写上去哪儿，AI 才能帮你想')
    setLoading(true)
    setErr(null)
    try {
      setRes(
        await api.ai.preferences({
          destination: destination.trim(),
          days,
          start_date: startDate || undefined,
          together,
          draft: value.trim() || undefined,
        }),
      )
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }
  const used = (s: string) => value.includes(s)
  const append = (s: string) => {
    if (used(s)) return
    const cur = value.trim()
    onChange((cur ? `${cur.replace(/[，,。.;；\s]+$/, '')}，${s}` : s).slice(0, 300))
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium tracking-[0.06em] text-ink-500">偏好和要求</span>
        <button
          type="button"
          onClick={help}
          disabled={disabled || loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-brand-300 bg-brand-50 px-3 text-[12.5px] font-medium text-ink-900 transition-colors hover:border-brand-500 disabled:opacity-50"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <WandSparkles className="size-3.5 text-brand-500" strokeWidth={1.5} />}
          {loading ? 'AI 正在想…' : res ? '换一批' : 'AI 帮我写'}
        </button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={300}
        disabled={disabled}
        placeholder="情侣出游，想吃本地特色小吃，喜欢拍照，不想太累，预算中等，避开网红坑"
        className="min-h-24 text-[15px] leading-[1.8]"
      />
      <p className="mt-1 text-xs text-ink-400">越具体越好：同行人、节奏、预算、爱吃什么、想拍照还是躺平</p>
      {err && <p className="mt-2 text-xs leading-relaxed text-brand-600">没能生成建议：{err}</p>}
      {res && (
        <div className="animate-fade-in mt-4 space-y-3 rounded-lg border border-ink-200 p-4">
          {res.suggestions.length > 0 && (
            <div>
              <p className="mb-2 text-[12px] text-ink-500">点一下加到上面（可以多选）</p>
              <div className="flex flex-wrap gap-1.5">
                {res.suggestions.map((s) => (
                  <ChoiceChip key={s} size="sm" role="button" selected={used(s)} onClick={() => append(s)} className="h-auto min-h-8 py-1 whitespace-normal">
                    {s}
                  </ChoiceChip>
                ))}
              </div>
            </div>
          )}
          {res.text && (
            <div className="border-t border-ink-200 pt-3">
              <p className="text-[12px] text-ink-500">AI 整理好的一段：</p>
              <p className="mt-1.5 text-[14px] leading-[1.8] text-ink-800">{res.text}</p>
              <Button
                size="sm"
                variant={value.trim() === res.text.trim() ? 'outline' : 'primary'}
                className="mt-2.5"
                disabled={value.trim() === res.text.trim()}
                icon={value.trim() === res.text.trim() ? <Check className="size-3.5" strokeWidth={2} /> : undefined}
                onClick={() => onChange(res.text.slice(0, 300))}
              >
                {value.trim() === res.text.trim() ? '已使用这段' : '用这段替换'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** AI 草稿里的一项：带上用户确认过的位置 */
interface DraftItem extends AIPlanItem {
  key: number
  /** 用户在地图上确认 / 重新选择的位置 */
  confirmed?: ConfirmedPlace
}
const placed = (i: DraftItem) => !!i.confirmed || isVerified(i)
const posOf = (i: DraftItem): LngLat | null => (i.confirmed ? [i.confirmed.lng, i.confirmed.lat] : hasCoord(i) ? [i.lng!, i.lat!] : null)

/** 草稿预览地图：每天一种颜色的直线示意（保存后按实际道路计算），住宿是床的方章 */
function DraftMap({ items, days }: { items: DraftItem[]; days: number[] }) {
  const { segments, markers, pts } = useMemo(() => {
    const segments: RouteSegment[] = []
    const markers: PlanMarkerItem[] = []
    const pts: LngLat[] = []
    const lodgingOf = new Map<number, DraftItem>()
    for (const i of items) if (isLodgingItem(i) && placed(i)) lodgingOf.set(i.day, i)
    const fake = (i: DraftItem, p: LngLat) =>
      ({ id: -i.key, name: i.confirmed?.name || i.name, lng: p[0], lat: p[1], kind: isLodgingItem(i) ? 'lodging' : 'stop', planned: true, status: 'todo', category: i.category, verdict: '' }) as Waypoint
    for (const d of days) {
      const chain: LngLat[] = []
      const start = lodgingOf.get(d - 1)
      if (start) chain.push(posOf(start)!)
      let n = 0
      for (const i of items) {
        if (i.day !== d || isLodgingItem(i) || !placed(i)) continue
        const p = posOf(i)!
        chain.push(p)
        pts.push(p)
        markers.push({ w: fake(i, p), label: String(++n), tone: dayTone(d).v })
      }
      const end = lodgingOf.get(d)
      if (end) {
        const p = posOf(end)!
        chain.push(p)
        pts.push(p)
        markers.push({ w: fake(end, p), tone: dayTone(d).v })
      }
      for (let k = 1; k < chain.length; k++)
        segments.push({ id: `ai-${d}-${k}`, path: [chain[k - 1], chain[k]], kind: 'planned', color: dayTone(d).v })
    }
    return { segments, markers, pts }
  }, [items, days])
  if (!pts.length) return null
  return (
    <div className="-mx-4 overflow-hidden border-y border-ink-200 md:mx-0 md:rounded-sm md:border-0 md:ring-1 md:ring-ink-200">
      <BaseMap className="h-72 md:h-[24rem]" navigation={false}>
        <RouteSegments segments={segments} idPrefix="ai" icons={false} />
        <PlanMarkers items={markers} />
        <FitOnce points={pts} fitKey={`ai-${pts.length}`} />
      </BaseMap>
    </div>
  )
}

function AIPlanner({
  onUse,
  lead,
  before,
  together,
}: {
  onUse: (r: AIPlanResult, items: DraftItem[], days: number, startDate: string) => Promise<void>
  /** 表单左侧的引导语 */
  lead: ReactNode
  /** 表单上方的额外选项（和 TA 一起） */
  before?: ReactNode
  /** 情侣同行（给 AI 帮写偏好用） */
  together: boolean
}) {
  // 宽屏：草稿左栏吸顶放标题和「创建」按钮；窄屏：按钮放在全部地点之后
  const wide = useMediaQuery('(min-width: 1024px)')
  const [f, setF] = useState({ destination: '', days: 2, preferences: '', start_date: '' })
  const [result, setResult] = useState<AIPlanResult | null>(null)
  const [items, setItems] = useState<DraftItem[]>([])
  const [confirming, setConfirming] = useState<DraftItem | null>(null)
  const [using, setUsing] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

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
      setItems(r.items.map((i, k) => ({ ...i, key: k + 1 })))
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

  const days = useMemo(() => [...new Set(items.map((i) => i.day))].sort((a, b) => a - b), [items])
  const toSave = items.filter(placed)
  const unconfirmed = items.filter((i) => !placed(i))
  const stops = items.filter((i) => !isLodgingItem(i))
  const nights = items.filter(isLodgingItem)
  const busy = !!run

  const decision = result && (
    <div className="space-y-6">
      {unconfirmed.length > 0 && (
        <div className="space-y-2 border-l border-amber-500 py-1 pl-4">
          <p className="text-[13.5px] text-ink-900">还有 {unconfirmed.length} 个地点的位置需要你确认</p>
          <p className="text-xs leading-relaxed text-ink-500">
            AI 没能在地图上准确找到它们。点「在地图上确认」选好位置后会一起加入；不确认的不会加入路线，之后也可以在编辑页搜索添加。
          </p>
        </div>
      )}
      <div>
        <Button
          size="lg"
          variant="accent"
          className="w-full sm:w-auto sm:min-w-64"
          loading={using}
          disabled={!toSave.length}
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
        <p className="mt-3 max-w-sm text-xs leading-relaxed text-ink-500">创建后会打开按天规划的编辑页，可以继续调整顺序、换住宿、一键重排</p>
      </div>
    </div>
  )

  return (
    <>
      <DetailGrid lead={lead}>
        <div className="space-y-8">
          {before}
          <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4">
              <Field label="去哪儿">
                <Input
                  value={f.destination}
                  onChange={(e) => setF({ ...f, destination: e.target.value })}
                  maxLength={30}
                  placeholder="如：台州、成都+重庆、大理"
                  className={titleInput}
                />
              </Field>
              <div>
                <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">玩几天</span>
                <Stepper value={f.days} min={1} max={15} onChange={(d) => setF({ ...f, days: d })} unit="天" label="天数" className="h-12" />
              </div>
            </div>
            <Field label="出发日期（可选）" className="sm:max-w-xs">
              <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} className={dateInput} />
            </Field>
            <PreferencesField
              value={f.preferences}
              onChange={(v) => setF((x) => ({ ...x, preferences: v }))}
              destination={f.destination}
              days={f.days}
              startDate={f.start_date}
              together={together}
              disabled={busy}
            />
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
          {run && (
            <div className="pt-6 md:pt-10">
              <PlanProgress run={run} onCancel={cancel} />
            </div>
          )}
        </div>
      </DetailGrid>

      {/* 草稿：独立成整宽的一节——左栏吸顶放标题、概要和唯一的决定按钮，右栏地图与逐日地点 */}
      {result && !run && (
        <section className="animate-slide-up mt-16 md:mt-24">
          <LabelRow
            eyebrow="Draft · AI 行程草稿"
            note={`${stops.length} 个地点${nights.length ? ` · ${nights.length} 晚住宿` : ''}`}
            aside={`${days.length} 天`}
          />
          <div className="mt-8 grid gap-y-10 md:mt-10 lg:grid-cols-12 lg:gap-x-8">
            <div className="lg:col-span-4">
              <div className="lg:sticky lg:top-24">
                <h2 className="text-display-md text-balance text-ink-900">{result.title}</h2>
                {result.summary && <p className="mt-4 max-w-xl text-[14.5px] leading-[1.85] text-ink-500">{result.summary}</p>}
                <dl className="mt-6 flex divide-x divide-ink-200 border-y border-ink-200">
                  <div className="py-4 pr-6">
                    <dt className="eyebrow">Stops · 地点</dt>
                    <dd className="font-num mt-3 text-[2.25rem] leading-[0.9] font-light text-ink-900">
                      {stops.length}
                      <span className="ml-1.5 font-sans text-xs text-ink-500">个</span>
                    </dd>
                  </div>
                  <div className="px-6 py-4">
                    <dt className="eyebrow">Days · 天数</dt>
                    <dd className="font-num mt-3 text-[2.25rem] leading-[0.9] font-light text-ink-900">
                      {days.length}
                      <span className="ml-1.5 font-sans text-xs text-ink-500">天</span>
                    </dd>
                  </div>
                  {nights.length > 0 && (
                    <div className="py-4 pl-6">
                      <dt className="eyebrow">Nights · 住宿</dt>
                      <dd className="font-num mt-3 text-[2.25rem] leading-[0.9] font-light text-ink-900">
                        {nights.length}
                        <span className="ml-1.5 font-sans text-xs text-ink-500">晚</span>
                      </dd>
                    </div>
                  )}
                </dl>
                {wide && <div className="mt-8">{decision}</div>}
              </div>
            </div>
            <div className="min-w-0 lg:col-span-7 lg:col-start-6">
              <DraftMap items={items} days={days} />
              <div className="mt-10 space-y-12 md:mt-12 md:space-y-14">
                {days.map((d) => {
                  const list = items.filter((i) => i.day === d && !isLodgingItem(i))
                  const night = items.filter((i) => i.day === d && isLodgingItem(i))
                  const date = f.start_date ? dayjs(f.start_date).add(d - 1, 'day') : null
                  return (
                    <div key={d}>
                      <div className="flex items-end gap-4 border-b border-ink-200 pb-3">
                        <span className="font-num text-[2.5rem] leading-[0.8] font-light text-ink-900 md:text-[3rem]">{pad2(d)}</span>
                        <div className="min-w-0 pb-0.5 text-[13px] leading-[1.45]">
                          <p className="text-ink-900">
                            <span className={cn('mr-2 inline-block size-2 translate-y-[-1px] rounded-full', dayTone(d).bg)} aria-hidden />
                            <span className="eyebrow !text-ink-900">Day {pad2(d)}</span>
                            {date && <span className="ml-3">{date.format('M月D日')}</span>}
                          </p>
                          <p className="text-ink-500">{date ? date.format('dddd') : `第 ${d} 天`}</p>
                        </div>
                        <span className="caption ml-auto shrink-0 pb-0.5">
                          <span className="font-num text-[14px]">{list.length}</span> 个地点
                        </span>
                      </div>
                      <ol className="divide-y divide-ink-200">
                        {[...list, ...night].map((i) => {
                          const lodging = isLodgingItem(i)
                          const ok = placed(i)
                          const n = list.indexOf(i) + 1
                          return (
                            <li key={i.key} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 py-5 md:grid-cols-[2.75rem_minmax(0,1fr)] md:py-6">
                              {lodging ? (
                                <span
                                  className="mt-0.5 flex size-8 items-center justify-center rounded-md border-[1.5px] bg-surface-2 text-ink-900"
                                  style={{ borderColor: `var(${dayTone(d).v})` }}
                                  title="住宿"
                                >
                                  <Bed className="size-4" strokeWidth={1.5} />
                                </span>
                              ) : (
                                <span
                                  className={cn(
                                    'font-num mt-0.5 flex size-8 items-center justify-center rounded-full text-sm leading-none',
                                    ok ? 'border border-ink-700 text-ink-900' : 'border border-dashed border-amber-500 text-amber-700',
                                  )}
                                >
                                  {n}
                                </span>
                              )}
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                  {lodging ? (
                                    <span className="eyebrow !text-ink-700">住宿 · 第 {d} 晚</span>
                                  ) : (
                                    <CategoryChip category={i.category} />
                                  )}
                                  {i.confirmed ? (
                                    <span className="inline-flex items-center gap-1 tracking-wide text-emerald-700">
                                      <Check className="size-3" strokeWidth={2} />
                                      已确认位置
                                    </span>
                                  ) : (
                                    !ok && (
                                      <span className="inline-flex items-center gap-1 tracking-wide text-amber-700">
                                        <TriangleAlert className="size-3" strokeWidth={1.5} />
                                        {lodging && i.located ? '请确认住哪一家' : '位置待确认'}
                                      </span>
                                    )
                                  )}
                                </div>
                                <p className={cn('font-display mt-1.5 text-[18px] leading-[1.3] md:text-[20px]', ok ? 'text-ink-900' : 'text-ink-700')}>
                                  {i.confirmed?.name || i.name}
                                </p>
                                {(i.confirmed?.address || i.address) && <p className="caption mt-1">{i.confirmed?.address || i.address}</p>}
                                {i.note && <p className="mt-2.5 max-w-xl text-[14px] leading-[1.8] text-ink-500">{i.note}</p>}
                                {!isVerified(i) && (
                                  <button
                                    type="button"
                                    onClick={() => setConfirming(i)}
                                    className={cn(
                                      'mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] transition-colors',
                                      i.confirmed ? 'border-ink-200 text-ink-700 hover:border-ink-500' : 'border-amber-500 text-ink-900 hover:bg-amber-50',
                                    )}
                                  >
                                    <MapPin className="size-3.5" strokeWidth={1.5} />
                                    {i.confirmed ? '重新选择位置' : '在地图上确认'}
                                  </button>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    </div>
                  )
                })}
              </div>
              {!wide && <div className="mt-12 border-t border-ink-200 pt-6">{decision}</div>}
            </div>
          </div>
        </section>
      )}
      {confirming && (
        <ConfirmPlaceDialog
          open
          name={confirming.name}
          {...(isLodgingItem(confirming) && !HOTELISH.test(confirming.name)
            ? {
                title: `第 ${confirming.day} 晚住哪儿？`,
                hint: `AI 写的住宿「${confirming.name}」不是一家具体的酒店或民宿。`,
                keyword: `${confirming.name} 民宿`,
              }
            : {})}
          city={confirming.city || f.destination}
          guess={hasCoord(confirming) ? [confirming.lng!, confirming.lat!] : null}
          onClose={() => setConfirming(null)}
          onConfirm={(p) => {
            setItems((list) => list.map((x) => (x.key === confirming.key ? { ...x, confirmed: p } : x)))
            setConfirming(null)
          }}
        />
      )}
    </>
  )
}

export default function NewTripPage() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const user = useAuth((s) => s.user)
  const { data: site } = useSite()
  const [mode, setMode] = useState<Mode>(params.get('ai') ? 'ai' : 'plan')
  const qc = useQueryClient()
  // 自己规划：按日期或按天数（编辑页按天显示页签）
  const [by, setBy] = useState<'days' | 'dates'>('days')
  const [f, setF] = useState({ title: '', start_date: '', end_date: '', days: 2, with_partner: !!user?.partner })
  const [creating, setCreating] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // AI 规划：路线没保存成功、刚建的旅程也没删掉时记下来，重试前先删，避免留下空旅程
  const orphanTrip = useRef<number | null>(null)
  // 进入页面后才刷新到的情侣绑定（或刚解除绑定）：同步「和 TA 一起」的默认值
  const partnerId = user?.partner?.id
  useEffect(() => {
    setF((p) => ({ ...p, with_partner: !!partnerId }))
  }, [partnerId])

  const dateDays = f.start_date && f.end_date ? dayjs(f.end_date).diff(dayjs(f.start_date), 'day') + 1 : 0

  const create = async () => {
    if (!f.title.trim()) return toast.error('给旅程起个名字吧')
    if (mode === 'plan' && by === 'dates' && f.start_date && f.end_date && dateDays < 1) return toast.error('结束日期不能早于开始日期')
    setCreating(true)
    try {
      const phase: Phase = mode === 'photos' ? 'finished' : 'planning'
      const useDays = mode === 'plan' && by === 'days'
      const t = await api.trips.create({
        title: f.title.trim(),
        start_date: useDays ? null : f.start_date || null,
        end_date: useDays ? null : f.end_date || null,
        days: useDays ? f.days : undefined,
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

  // picked：AIPlanner 挑出的要加入路线的地点（都已校正或由用户确认了位置）
  const useAIPlan = async (r: AIPlanResult, picked: DraftItem[], days: number, startDate: string) => {
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
        days: start ? undefined : days,
        with_partner: f.with_partner && !!user?.partner,
      })
      createdId = t.id
      invalidateTripLists(qc)
      const items: WaypointInput[] = picked.map((i) => {
        const c = i.confirmed
        return {
          // 用户重新选了地点：用那个地点的名称、地址和高德 ID；只点了位置时保留 AI 给的名称
          name: c?.name || i.name,
          address: c ? c.address || '' : i.address,
          lng: c ? c.lng : i.lng!,
          lat: c ? c.lat : i.lat!,
          category: isLodgingItem(i) ? 'hotel' : c?.category || i.category,
          day: i.day,
          kind: isLodgingItem(i) ? 'lodging' : 'stop',
          note: i.note,
          amap_id: c ? c.amap_id : i.amap_id || undefined,
          planned: true,
        }
      })
      if (items.length) await api.waypoints.batch(t.id, items)
      const left = r.items.length - items.length
      toast.success(left > 0 ? `已创建，${left} 个地点没有确认位置、未加入，可在编辑页搜索添加` : '已创建，可以继续按天调整路线')
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

  const lead = (
    <p className="font-display text-[17px] leading-[1.6] text-ink-700 md:text-[19px]">
      {mode === 'plan' && '先起个名字、定下玩几天，再把想去的地方排进每一天。'}
      {mode === 'ai' && '说说去哪儿、玩几天和你的偏好，AI 会写出一份逐日的草稿，包括每晚住哪儿。'}
      {mode === 'photos' && '把旅途中的照片交给我们，按拍摄地点和时间还原足迹。'}
    </p>
  )

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
    <div className="mx-auto max-w-[90rem] px-4 pt-8 pb-24 md:px-8 md:pt-14 md:pb-32">
      <header className="max-w-3xl">
        <p className="eyebrow animate-fade-in">New Journey · 新的旅程</p>
        <h1 className="text-display-lg animate-slide-up mt-3 text-ink-900 md:mt-4">这一次，从哪里开始？</h1>
        <p className="animate-fade-in mt-3 max-w-xl text-[14.5px] leading-[1.8] text-ink-500">
          先定个方向，细节随时可以改。路线、照片和游记，都会慢慢长成一段完整的旅程。
        </p>
      </header>

      {/* 三种方式：卡片式单选，选中的是强调色边框 + 实心对勾 + 底色 */}
      <section className="mt-10 md:mt-14">
        <LabelRow eyebrow="Begin · 开始方式" aside="选一种" />
        <div role="radiogroup" aria-label="创建方式" className={cn('mt-4 grid gap-3', available.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
          {available.map((m) => (
            <ChoiceCard
              key={m.value}
              selected={mode === m.value}
              title={
                <span className="inline-flex items-center gap-2">
                  {m.value === 'ai' && <Sparkles className="size-4 text-brand-500" strokeWidth={1.5} />}
                  {m.title}
                </span>
              }
              desc={m.desc}
              onClick={() => {
                setMode(m.value)
                // 只在明确选了方式之后把光标放进名称框，且不滚动页面；手机上不弹键盘
                if (m.value !== 'ai' && window.matchMedia('(pointer: fine)').matches)
                  requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }))
              }}
            />
          ))}
        </div>
        {/* 面向管理员的配置提示：普通用户看不到，站点配置加载完之前也不显示 */}
        {site && !site.ai_enabled && isAdmin(user) && (
          <p className="mt-4 text-xs text-ink-500">提示：管理员在服务器配置 AI 模型后，可以使用「AI 帮我规划」和「智能推荐下一站」。</p>
        )}
      </section>

      {/* 细节：左侧引导语，右侧表单 */}
      <section className="mt-12 md:mt-16">
        <LabelRow eyebrow="Details · 旅程信息" note={current?.title} />
        {mode === 'ai' ? (
          <AIPlanner onUse={useAIPlan} lead={lead} before={partnerSwitch} together={f.with_partner && !!user?.partner} />
        ) : (
          <DetailGrid lead={lead}>
            <div className="space-y-7">
              <Field label="旅程名称">
                <Input
                  ref={titleRef}
                  value={f.title}
                  onChange={(e) => setF({ ...f, title: e.target.value })}
                  placeholder={mode === 'photos' ? '如：2026 国庆 · 青甘大环线' : '如：五一杭州两日游'}
                  maxLength={80}
                  className={titleInput}
                />
              </Field>
              {mode === 'plan' ? (
                <div className="space-y-4">
                  <div>
                    <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">怎么安排时间</span>
                    <div role="radiogroup" aria-label="怎么安排时间" className="flex flex-wrap gap-1.5">
                      <ChoiceChip selected={by === 'days'} onClick={() => setBy('days')}>
                        按天数（还没定日期）
                      </ChoiceChip>
                      <ChoiceChip selected={by === 'dates'} onClick={() => setBy('dates')}>
                        按日期
                      </ChoiceChip>
                    </div>
                  </div>
                  {by === 'days' ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Stepper value={f.days} min={1} max={30} onChange={(d) => setF({ ...f, days: d })} unit="天" label="玩几天" className="h-11" />
                      <div className="flex flex-wrap gap-1.5">
                        {[1, 2, 3, 5, 7].map((d) => (
                          <ChoiceChip key={d} size="sm" selected={f.days === d} onClick={() => setF({ ...f, days: d })}>
                            {d} 天
                          </ChoiceChip>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-4">
                      <Field label="开始日期">
                        <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} className={dateInput} />
                      </Field>
                      <Field label="结束日期">
                        <Input
                          type="date"
                          value={f.end_date}
                          min={f.start_date}
                          onChange={(e) => setF({ ...f, end_date: e.target.value })}
                          className={dateInput}
                        />
                      </Field>
                    </div>
                  )}
                  <p className="text-xs text-ink-500">
                    {by === 'days'
                      ? `编辑页会显示「第 1 天 … 第 ${f.days} 天」的页签，之后也可以随时增减天数或补上日期`
                      : dateDays > 0
                        ? `共 ${dateDays} 天，编辑页按日期显示每一天`
                        : '选好日期后，编辑页按日期显示每一天'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-4">
                  <Field label="开始日期">
                    <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} className={dateInput} />
                  </Field>
                  <Field label="结束日期">
                    <Input type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} className={dateInput} />
                  </Field>
                </div>
              )}
              {partnerSwitch}
              <div className="border-t border-ink-200 pt-6">
                <Button size="lg" variant="accent" className="w-full sm:w-auto sm:min-w-64" loading={creating} onClick={create}>
                  {mode === 'photos' ? '创建并上传照片' : '创建并开始规划'}
                  {!creating && <ArrowRight className="size-4" strokeWidth={1.5} />}
                </Button>
              </div>
            </div>
          </DetailGrid>
        )}
      </section>
    </div>
  )
}
