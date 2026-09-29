import { useState } from 'react'
import { Check } from 'lucide-react'
import type { Category, Phase, Verdict, Waypoint, WaypointInput, WaypointStatus } from '@/api/types'
import { Button, Field, Input, Select, Stars, Textarea } from '@/components/ui'
import { ChoiceChip } from './Choice'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { categories, categoryList, verdicts } from '@/lib/meta'

const toLocal = (t: string | null) => (t ? dayjs(t).format('YYYY-MM-DDTHH:mm') : '')
const fromLocal = (v: string) => (v ? dayjs(v).toISOString() : null)

export function WaypointForm({
  w,
  phase,
  maxDay,
  onSave,
  onCancel,
  saving,
  poolLabel = '未分天',
}: {
  w: Waypoint
  phase: Phase
  maxDay: number
  onSave: (patch: WaypointInput) => void
  onCancel: () => void
  saving?: boolean
  /** day=0 的名称：规划中为「想去的地方」 */
  poolLabel?: string
}) {
  // 住宿：没有分类，「第几天」是「第几晚」（0 为出发前一晚）
  const lodging = w.kind === 'lodging'
  // 还没保存的新地点（草稿里）：保存后才能标记打卡状态
  const unsaved = w.id < 0
  const [f, setF] = useState({
    name: w.name,
    address: w.address,
    category: w.category,
    day: w.day,
    note: w.note,
    verdict: w.verdict,
    rating: w.rating,
    cost: w.cost,
    planned_at: toLocal(w.planned_at),
    arrived_at: toLocal(w.arrived_at),
    status: w.status,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const showExperience = phase !== 'planning' || w.status === 'visited'

  return (
    // 不带外框：放在编辑行 / 弹窗里，由外层决定底色和分隔线
    <div className="space-y-5" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        <Field label={lodging ? '住宿名称' : '名称'} className="col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} className="font-display h-11 text-[17px]" />
        </Field>
        {!lodging && (
          <Field label="分类">
            <Select value={f.category} onChange={(e) => set('category', e.target.value as Category)}>
              {categoryList.map((c) => (
                <option key={c} value={c}>
                  {categories[c].label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {lodging ? (
          <Field label="第几晚">
            <Select value={f.day} onChange={(e) => set('day', Number(e.target.value))}>
              <option value={0}>出发前一晚</option>
              {Array.from({ length: Math.max(maxDay, 1) }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  第 {d} 晚
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="第几天">
            <Select value={f.day} onChange={(e) => set('day', Number(e.target.value))}>
              <option value={0}>{poolLabel}</option>
              {Array.from({ length: Math.max(maxDay, 1) + 1 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  第 {d} 天
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="详细地址" className="col-span-2">
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={200} />
        </Field>
        {w.planned && !lodging && (
          // 手机上时间框单独一行，日期和时间不会被截断
          <Field label="计划时间" className="col-span-2 sm:col-span-1">
            <Input type="datetime-local" value={f.planned_at} onChange={(e) => set('planned_at', e.target.value)} />
          </Field>
        )}
        {(phase !== 'planning' || !w.planned) && !unsaved && (
          <Field label="实际到达" className="col-span-2 sm:col-span-1">
            <Input type="datetime-local" value={f.arrived_at} onChange={(e) => set('arrived_at', e.target.value)} />
          </Field>
        )}
      </div>

      {w.planned && phase !== 'planning' && !unsaved && (
        <div>
          <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">状态</span>
          <div role="radiogroup" aria-label="状态" className="flex flex-wrap gap-1.5">
            {(
              [
                ['todo', '待前往'],
                ['visited', '已打卡'],
                ['skipped', '跳过'],
              ] as [WaypointStatus, string][]
            ).map(([v, label]) => (
              <ChoiceChip
                key={v}
                size="sm"
                selected={f.status === v}
                // 旅行中标记为已打卡时预填当前时间：到达时间为空会让整条实际路线改按顺序排列
                onClick={() =>
                  setF((x) => ({
                    ...x,
                    status: v,
                    arrived_at: v === 'visited' && !x.arrived_at && phase === 'ongoing' ? dayjs().format('YYYY-MM-DDTHH:mm') : x.arrived_at,
                  }))
                }
              >
                {label}
              </ChoiceChip>
            ))}
          </div>
        </div>
      )}

      {showExperience && (
        <>
          <div>
            <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">体验如何</span>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="体验如何">
              {(Object.keys(verdicts) as Exclude<Verdict, ''>[]).map((v) => {
                const on = f.verdict === v
                const c = verdicts[v].color
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('verdict', on ? '' : v)}
                    className={cn(
                      'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[13.5px] tracking-wide transition-colors duration-300',
                      on && 'border-[1.5px]',
                      on ? 'font-medium' : 'border-ink-200 text-ink-500 hover:border-ink-500 hover:text-ink-900',
                    )}
                    style={on ? { color: c, borderColor: c + '99', background: c + '14' } : undefined}
                  >
                    {on ? <Check className="size-3.5" strokeWidth={2.5} /> : <span className="text-[11px] leading-none">{verdicts[v].mark}</span>}
                    {verdicts[v].label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2 text-xs font-medium tracking-[0.06em] text-ink-500">
              评分 <Stars value={f.rating} onChange={(v) => set('rating', v)} size={20} />
            </div>
            <label className="flex items-center gap-2 text-xs font-medium tracking-[0.06em] text-ink-500">
              人均 ¥
              <Input
                type="number"
                min={0}
                value={f.cost || ''}
                onChange={(e) => set('cost', Number(e.target.value) || 0)}
                className="font-num h-9 w-24 text-[15px]"
              />
            </label>
          </div>
        </>
      )}
      <Field label={showExperience ? '备注 / 攻略 / 避雷提示' : '备注 / 计划要点'}>
        <Textarea
          value={f.note}
          onChange={(e) => set('note', e.target.value)}
          maxLength={2000}
          placeholder={
            showExperience ? '比如：排队1小时，强烈建议提前预约；招牌菜偏咸…' : '比如：记得提前在小程序预约门票；开放时间 9:00-17:00'
          }
        />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button
          loading={saving}
          onClick={() =>
            onSave({
              // 只在用户改了名称时提交：原样回传自动生成的名称会被当成用户命名，进而新建地点（清空则恢复自动命名）
              name: f.name.trim() !== w.name ? f.name.trim() : undefined,
              address: f.address,
              category: lodging ? undefined : f.category,
              day: f.day !== w.day ? f.day : undefined,
              note: f.note,
              verdict: f.verdict,
              rating: f.rating,
              cost: f.cost,
              planned_at: w.planned && !lodging ? fromLocal(f.planned_at) : undefined,
              arrived_at: (phase !== 'planning' || !w.planned) && !unsaved ? fromLocal(f.arrived_at) : undefined,
              status: w.planned && phase !== 'planning' && !unsaved ? f.status : undefined,
            })
          }
        >
          保存
        </Button>
      </div>
    </div>
  )
}
