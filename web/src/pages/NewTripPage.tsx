import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, Check, Heart, PenLine, Sparkles, TriangleAlert } from 'lucide-react'
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

const modes: { value: Mode; title: string; desc: string; icon: typeof PenLine }[] = [
  { value: 'plan', title: '自己规划路线', desc: '搜索地点、排好顺序，出发时按图打卡', icon: PenLine },
  { value: 'ai', title: 'AI 帮我规划', desc: '告诉 AI 目的地和喜好，自动写出每天的行程', icon: Sparkles },
  { value: 'photos', title: '已经玩回来了', desc: '上传照片，按拍摄地点自动生成足迹', icon: Camera },
]

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
    <div className="animate-fade-in rounded-xl border border-ink-200 bg-surface px-5 pt-5 pb-4" aria-live="polite" aria-busy="true">
      <div className="flex items-center justify-between">
        <p className="eyebrow">AI Planning · 生成中</p>
        <ol className="flex items-center gap-3 text-[11px] tracking-wide" aria-label="生成步骤">
          {stages.map((s, i) => {
            const done = i < idx
            const on = i === idx
            return (
              <li key={s.key} className={cn('flex items-center gap-1', on ? 'text-ink-900' : done ? 'text-ink-500' : 'text-ink-300')}>
                <span
                  className={cn(
                    'font-num flex size-4 items-center justify-center rounded-full text-[9.5px] leading-none',
                    on ? 'bg-brand-500 text-white' : done ? 'bg-ink-900 text-paper' : 'border border-ink-300',
                  )}
                >
                  {done ? <Check className="size-2.5" strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
              </li>
            )
          })}
        </ol>
      </div>
      <p className="font-display mt-4 text-[22px] leading-snug text-ink-900">{cur.title}</p>
      <p className="mt-1 min-h-5 text-[13px] leading-relaxed text-ink-500">
        {run.legacy ? '一份多日行程通常需要 20–60 秒，请稍候' : run.message || cur.hint}
      </p>
      <IndeterminateLine className="mt-5" label="AI 正在生成行程" />
      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="flex divide-x divide-ink-200">
          {!run.legacy && (
            <div className="pr-5">
              <div className="font-num text-[1.75rem] leading-none font-[450] tracking-tight text-ink-900 tabular-nums">
                {run.chars.toLocaleString()}
              </div>
              <div className="mt-1.5 text-[11px] tracking-[0.12em] text-ink-400">已写字数</div>
            </div>
          )}
          <div className={cn(!run.legacy && 'pl-5')}>
            <div className="font-num text-[1.75rem] leading-none font-[450] tracking-tight text-ink-900 tabular-nums">
              {elapsed}
              <span className="ml-1 text-xs text-ink-400">秒</span>
            </div>
            <div className="mt-1.5 text-[11px] tracking-[0.12em] text-ink-400">已用时</div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
      {slow && (
        <p className="mt-3 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-400">
          这次想得有点久。可以继续等待；也可以取消后减少天数、把要求写得更简短再试。
        </p>
      )}
    </div>
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
    <div className="space-y-6">
      <div className="space-y-4 rounded-xl border border-ink-200 bg-surface p-5">
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="去哪儿">
              <Input
                value={f.destination}
                onChange={(e) => setF({ ...f, destination: e.target.value })}
                maxLength={30}
                placeholder="如：台州、成都+重庆、大理"
                className="font-display text-base"
              />
            </Field>
            <Field label="玩几天">
              <Input
                type="number"
                min={1}
                max={15}
                value={f.days}
                onChange={(e) => setF({ ...f, days: Math.min(15, Math.max(1, Number(e.target.value) || 1)) })}
                className="font-num"
              />
            </Field>
          </div>
          <Field label="出发日期（可选）">
            <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
          </Field>
          <Field label="偏好和要求" hint="越具体越好：同行人、节奏、预算、爱吃什么、想拍照还是躺平">
            <Textarea
              value={f.preferences}
              onChange={(e) => setF({ ...f, preferences: e.target.value })}
              maxLength={300}
              placeholder="情侣出游，想吃本地特色小吃，喜欢拍照，不想太累，预算中等，避开网红坑"
              className="min-h-20"
            />
          </Field>
        </fieldset>
        {!busy && (
          <Button
            block
            size="lg"
            variant={result ? 'outline' : 'accent'}
            disabled={!f.destination.trim()}
            icon={<Sparkles className="size-4" strokeWidth={1.75} />}
            onClick={generate}
          >
            {result ? '重新生成' : '生成行程'}
          </Button>
        )}
        {error && !busy && (
          <div role="alert" className="flex gap-2.5 border-l-2 border-brand-500 bg-brand-50/60 py-2.5 pr-3 pl-3 text-sm leading-relaxed text-brand-800">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-brand-600" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              <span className="font-medium">没能生成行程：</span>
              {error}
            </span>
          </div>
        )}
      </div>

      {run && <PlanProgress run={run} onCancel={cancel} />}

      {result && !run && (
        <section className="animate-slide-up overflow-hidden rounded-xl border border-ink-200 bg-surface">
          <div className="px-5 pt-5 pb-4">
            <p className="eyebrow">Draft · AI 行程草稿</p>
            <h3 className="mt-2 text-[22px] leading-snug">{result.title}</h3>
            {result.summary && <p className="mt-2 text-sm leading-relaxed text-ink-500">{result.summary}</p>}
          </div>
          {located.length > 0 && (
            <BaseMap className="h-56 border-y border-ink-200" navigation={false}>
              <RouteLines planned={located} idPrefix="ai" />
              <FitOnce points={located} fitKey={result.title + toSave.length} />
            </BaseMap>
          )}
          <div className="space-y-8 px-5 pt-6 pb-5">
            {days.map((d) => {
              const list = result.items.filter((i) => i.day === d)
              return (
                <div key={d}>
                  <div className="flex items-baseline gap-3 border-b border-ink-200 pb-2">
                    <span className="font-num text-[11px] font-medium tracking-[0.22em] text-brand-500 uppercase">Day</span>
                    <span className="font-num -ml-1 text-[1.75rem] leading-none font-[450] text-ink-900">{String(d).padStart(2, '0')}</span>
                    {f.start_date && (
                      <span className="text-[13px] tracking-wide text-ink-500">
                        {dayjs(f.start_date).add(d - 1, 'day').format('M月D日 · ddd')}
                      </span>
                    )}
                    <span className="ml-auto text-xs tracking-wide text-ink-400">
                      <span className="font-num">{list.length}</span> 个地点
                    </span>
                  </div>
                  <ol className="divide-y divide-ink-100">
                    {list.map((i, idx) => {
                      const est = isEstimated(i)
                      const none = !hasCoord(i)
                      return (
                        <li key={idx} className="flex gap-3.5 py-3.5">
                          <span
                            className={cn(
                              'font-num mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] leading-none',
                              none
                                ? 'border border-ink-300 bg-ink-100 text-ink-400'
                                : est
                                  ? 'border-[1.5px] border-dashed border-amber-500 text-amber-700'
                                  : 'bg-ink-900 text-paper',
                            )}
                            title={none ? '未找到位置' : est ? 'AI 估算位置' : '已校准位置'}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className={cn('font-display text-[16px] leading-snug', none ? 'text-ink-400' : 'text-ink-900')}>{i.name}</span>
                              <CategoryChip category={i.category} />
                              {est && (
                                <span className="inline-flex items-center gap-1 text-xs tracking-wide text-amber-700">
                                  <TriangleAlert className="size-3" strokeWidth={1.75} />
                                  AI 估算位置
                                </span>
                              )}
                              {none && <span className="text-xs tracking-wide text-ink-400">未找到位置</span>}
                            </div>
                            {i.address && <div className="mt-0.5 text-xs text-ink-400">{i.address}</div>}
                            {i.note && <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-500">{i.note}</p>}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )
            })}
            {estCount > 0 && (
              <div className="space-y-1.5 border-l-2 border-amber-400 bg-amber-50/60 py-3 pr-3 pl-3.5">
                <Switch checked={includeEst} onChange={setWithEst} label={`同时加入 ${estCount} 个 AI 估算位置的地点`} />
                <p className="text-xs leading-relaxed text-amber-800">
                  这些坐标未经地图服务校正，可能偏差几百米甚至几公里，加入后请在编辑页拖动标记核对
                </p>
              </div>
            )}
            <div className="border-t border-ink-200 pt-5">
              <Button
                block
                size="lg"
                variant="accent"
                loading={using}
                icon={<Check className="size-4" strokeWidth={1.75} />}
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
              <p className="mt-2.5 text-center text-xs leading-relaxed text-ink-400">
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

  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 pb-12 md:pt-14">
      <p className="eyebrow">New Journey · 新的旅程</p>
      <h1 className="mt-3 text-[30px] leading-tight md:text-[40px]">这一次，从哪里开始？</h1>
      <p className="mt-2 text-[15px] text-ink-500">先定个方向，细节随时可以改。</p>

      <div
        role="radiogroup"
        aria-label="创建方式"
        className={cn(
          'mt-8 grid divide-y divide-ink-200 border-y border-ink-200 sm:divide-x sm:divide-y-0',
          available.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
        )}
      >
        {available.map((m, i) => {
          const on = mode === m.value
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(m.value)}
              className={cn(
                'group relative flex items-start gap-4 px-4 py-4 text-left transition-colors sm:block sm:px-5 sm:pt-5 sm:pb-6',
                on ? 'bg-surface' : 'hover:bg-white/60',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'absolute top-0 bottom-0 left-0 w-[2px] transition-colors sm:right-0 sm:bottom-auto sm:h-[2px] sm:w-auto',
                  on ? 'bg-brand-500' : 'bg-transparent',
                )}
              />
              <span className="flex items-center justify-between sm:w-full">
                <span className={cn('font-num text-[13px] tracking-[0.2em]', on ? 'text-brand-500' : 'text-ink-400')}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <m.icon
                  className={cn('hidden size-5 transition-colors sm:block', on ? 'text-ink-900' : 'text-ink-300 group-hover:text-ink-500')}
                  strokeWidth={1.5}
                />
              </span>
              <span className="block min-w-0 flex-1 sm:mt-7">
                <span className={cn('font-display block text-[18px] leading-snug sm:text-[19px]', on ? 'text-ink-900' : 'text-ink-700')}>
                  {m.title}
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-ink-500">{m.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
      {/* 面向管理员的配置提示：普通用户看不到，站点配置加载完之前也不显示 */}
      {site && !site.ai_enabled && isAdmin(user) && (
        <p className="mt-3 text-xs text-ink-400">提示：管理员在服务器配置 AI 模型后，可以使用「AI 帮我规划」和「智能推荐下一站」。</p>
      )}

      <div className="mt-8 space-y-4">
        {mode !== 'ai' && (
          <div className="space-y-5 rounded-xl border border-ink-200 bg-surface p-5">
            <Field label="旅程名称">
              <Input
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                placeholder={mode === 'photos' ? '如：2026 国庆 · 青甘大环线' : '如：五一杭州两日游'}
                maxLength={80}
                autoFocus
                className="font-display h-11 text-base"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="开始日期">
                <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
              </Field>
              <Field label="结束日期">
                <Input type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} />
              </Field>
            </div>
            {user?.partner && (
              <Switch
                checked={f.with_partner}
                onChange={(v) => setF({ ...f, with_partner: v })}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-4 text-pink-500" strokeWidth={1.75} />和 {user.partner.nickname || user.partner.username} 一起
                  </span>
                }
              />
            )}
            <Button block size="lg" variant="accent" loading={creating} onClick={create}>
              {mode === 'photos' ? '创建并上传照片' : '创建并开始规划'}
            </Button>
          </div>
        )}
        {mode === 'ai' && (
          <>
            {user?.partner && (
              <Switch
                checked={f.with_partner}
                onChange={(v) => setF({ ...f, with_partner: v })}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-4 text-pink-500" strokeWidth={1.75} />和 {user.partner.nickname || user.partner.username} 一起
                  </span>
                }
              />
            )}
            <AIPlanner onUse={useAIPlan} amapSearch={site?.amap_search ?? true} />
          </>
        )}
      </div>
    </div>
  )
}
