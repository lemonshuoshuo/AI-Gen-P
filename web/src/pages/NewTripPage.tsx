import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { Camera, CheckCircle2, Heart, MapPin, PenLine, Sparkles, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type AIPlanResult, type Phase } from '@/api'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines } from '@/components/map/layers'
import { Button, CategoryChip, Card, Field, Input, Switch, Textarea } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { useAuth } from '@/stores/auth'

type Mode = 'plan' | 'ai' | 'photos'

const modes: { value: Mode; title: string; desc: string; icon: typeof PenLine }[] = [
  { value: 'plan', title: '自己规划路线', desc: '搜索地点、排好顺序，出发时按图打卡', icon: PenLine },
  { value: 'ai', title: 'AI 帮我规划', desc: '告诉 AI 目的地和喜好，自动生成行程', icon: Sparkles },
  { value: 'photos', title: '已经玩回来了', desc: '上传照片，按拍摄地点自动生成足迹', icon: Camera },
]

function AIPlanner({ onUse }: { onUse: (r: AIPlanResult, days: number, startDate: string) => Promise<void> }) {
  const [f, setF] = useState({ destination: '', days: 2, preferences: '', start_date: '' })
  const [result, setResult] = useState<AIPlanResult | null>(null)
  const [using, setUsing] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      api.ai.plan({
        destination: f.destination.trim(),
        days: f.days,
        preferences: f.preferences.trim() || undefined,
        start_date: f.start_date || undefined,
      }),
    onSuccess: setResult,
    onError: (e) => toast.error(errorMessage(e)),
  })
  const located = useMemo(
    () => (result?.items ?? []).filter((i) => i.lng != null && i.lat != null).map((i) => [i.lng!, i.lat!] as [number, number]),
    [result],
  )
  const days = [...new Set((result?.items ?? []).map((i) => i.day))].sort((a, b) => a - b)

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <Field label="去哪儿">
            <Input
              value={f.destination}
              onChange={(e) => setF({ ...f, destination: e.target.value })}
              placeholder="如：杭州、成都+重庆、大理"
            />
          </Field>
          <Field label="玩几天">
            <Input type="number" min={1} max={15} value={f.days} onChange={(e) => setF({ ...f, days: Math.min(15, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
        </div>
        <Field label="出发日期（可选）">
          <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
        </Field>
        <Field label="偏好和要求" hint="越具体越好：同行人、节奏、预算、爱吃什么、想拍照还是躺平">
          <Textarea
            value={f.preferences}
            onChange={(e) => setF({ ...f, preferences: e.target.value })}
            placeholder="情侣出游，想吃本地特色小吃，喜欢拍照，不想太累，预算中等，避开网红坑"
            className="min-h-20"
          />
        </Field>
        <Button
          block
          variant="dark"
          loading={m.isPending}
          disabled={!f.destination.trim()}
          icon={<Sparkles className="size-4" />}
          onClick={() => m.mutate()}
        >
          {m.isPending ? 'AI 正在规划，大约需要 10-30 秒…' : result ? '重新生成' : '生成行程'}
        </Button>
      </Card>

      {result && (
        <Card className="overflow-hidden">
          <div className="p-4">
            <h3 className="text-lg font-bold">{result.title}</h3>
            {result.summary && <p className="mt-1 text-sm text-ink-500">{result.summary}</p>}
          </div>
          {located.length > 0 && (
            <BaseMap className="h-56" navigation={false}>
              <RouteLines planned={located} idPrefix="ai" />
              <FitOnce points={located} fitKey={result.title + located.length} />
            </BaseMap>
          )}
          <div className="space-y-4 p-4">
            {days.map((d) => (
              <div key={d}>
                <div className="mb-2 text-sm font-bold text-brand-600">第 {d} 天</div>
                <div className="space-y-2">
                  {result.items
                    .filter((i) => i.day === d)
                    .map((i, idx) => (
                      <div key={idx} className="flex gap-2.5 rounded-xl bg-ink-50 p-2.5">
                        <MapPin className={cn('mt-0.5 size-4 shrink-0', i.located ? 'text-emerald-500' : 'text-amber-500')} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{i.name}</span>
                            <CategoryChip category={i.category} />
                            {!i.located && (
                              <span className="inline-flex items-center gap-0.5 text-xs text-amber-600">
                                <TriangleAlert className="size-3" />
                                位置待确认
                              </span>
                            )}
                          </div>
                          {i.address && <div className="text-xs text-ink-400">{i.address}</div>}
                          {i.note && <p className="mt-1 text-sm text-ink-600">{i.note}</p>}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))}
            <Button
              block
              loading={using}
              icon={<CheckCircle2 className="size-4" />}
              onClick={async () => {
                setUsing(true)
                try {
                  await onUse(result, f.days, f.start_date)
                } finally {
                  setUsing(false)
                }
              }}
            >
              就按这个来，创建旅程
            </Button>
            <p className="text-center text-xs text-ink-400">创建后可以在编辑页继续调整；位置待确认的地点不会加入路线</p>
          </div>
        </Card>
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
  const [f, setF] = useState({ title: '', start_date: '', end_date: '', with_partner: !!user?.partner })
  const [creating, setCreating] = useState(false)

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
      nav(`/trips/${t.id}/edit${mode === 'photos' ? '?panel=photos' : ''}`, { replace: true })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const useAIPlan = async (r: AIPlanResult, days: number, startDate: string) => {
    try {
      const start = startDate || null
      const t = await api.trips.create({
        title: r.title || f.title || 'AI 规划的旅程',
        summary: r.summary,
        phase: 'planning',
        start_date: start,
        end_date: start ? dayjs(start).add(days - 1, 'day').format('YYYY-MM-DD') : null,
        with_partner: f.with_partner && !!user?.partner,
      })
      const items = r.items
        .filter((i) => i.lng != null && i.lat != null)
        .map((i) => ({
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
      toast.success('已创建，可以继续调整路线')
      nav(`/trips/${t.id}/edit`, { replace: true })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const available = modes.filter((m) => m.value !== 'ai' || site?.ai_enabled)

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">新的旅程 ✈️</h1>
      <p className="mt-1 text-sm text-ink-500">先定个方向，细节随时可以改</p>

      <div className={cn('mt-5 grid gap-3', available.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        {available.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className={cn(
              'rounded-2xl p-4 text-left ring-2 transition',
              mode === m.value ? 'bg-white shadow-card ring-brand-400' : 'bg-white/60 ring-transparent hover:bg-white',
            )}
          >
            <m.icon className={cn('size-6', mode === m.value ? 'text-brand-500' : 'text-ink-400')} />
            <div className="mt-2 font-semibold">{m.title}</div>
            <div className="mt-0.5 text-xs text-ink-400">{m.desc}</div>
          </button>
        ))}
      </div>
      {!site?.ai_enabled && (
        <p className="mt-2 text-xs text-ink-400">提示：管理员在服务器配置 AI 模型后，可以使用「AI 帮我规划」和「智能推荐下一站」。</p>
      )}

      <div className="mt-6 space-y-4">
        {mode !== 'ai' && (
          <Card className="space-y-4 p-4">
            <Field label="旅程名称">
              <Input
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                placeholder={mode === 'photos' ? '如：2026 国庆 · 青甘大环线' : '如：五一杭州两日游'}
                maxLength={80}
                autoFocus
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
                  <span className="inline-flex items-center gap-1">
                    <Heart className="size-4 text-pink-500" />和 {user.partner.nickname || user.partner.username} 一起
                  </span>
                }
              />
            )}
            <Button block size="lg" loading={creating} onClick={create}>
              {mode === 'photos' ? '创建并上传照片' : '创建并开始规划'}
            </Button>
          </Card>
        )}
        {mode === 'ai' && (
          <>
            {user?.partner && (
              <Switch
                checked={f.with_partner}
                onChange={(v) => setF({ ...f, with_partner: v })}
                label={`和 ${user.partner.nickname || user.partner.username} 一起`}
              />
            )}
            <AIPlanner onUse={useAIPlan} />
          </>
        )}
      </div>
    </div>
  )
}
