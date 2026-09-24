import { useState } from 'react'
import type { Category, Phase, Verdict, Waypoint, WaypointInput, WaypointStatus } from '@/api/types'
import { Button, Field, Input, Segmented, Select, Stars, Textarea } from '@/components/ui'
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
}: {
  w: Waypoint
  phase: Phase
  maxDay: number
  onSave: (patch: WaypointInput) => void
  onCancel: () => void
  saving?: boolean
}) {
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
    <div className="space-y-3 rounded-2xl bg-ink-50 p-3" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="名称" className="col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
        </Field>
        <Field label="分类">
          <Select value={f.category} onChange={(e) => set('category', e.target.value as Category)}>
            {categoryList.map((c) => (
              <option key={c} value={c}>
                {categories[c].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="第几天">
          <Select value={f.day} onChange={(e) => set('day', Number(e.target.value))}>
            <option value={0}>未分天</option>
            {Array.from({ length: Math.max(maxDay, 1) + 1 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                第 {d} 天
              </option>
            ))}
          </Select>
        </Field>
        <Field label="详细地址" className="col-span-2">
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={200} />
        </Field>
        {w.planned && (
          <Field label="计划时间">
            <Input type="datetime-local" value={f.planned_at} onChange={(e) => set('planned_at', e.target.value)} />
          </Field>
        )}
        {(phase !== 'planning' || !w.planned) && (
          <Field label="实际到达">
            <Input type="datetime-local" value={f.arrived_at} onChange={(e) => set('arrived_at', e.target.value)} />
          </Field>
        )}
      </div>

      {w.planned && phase !== 'planning' && (
        <Field label="状态">
          <Segmented<WaypointStatus>
            size="sm"
            value={f.status}
            // 旅行中标记为已打卡时预填当前时间：到达时间为空会让整条实际路线改按顺序排列
            onChange={(v) =>
              setF((x) => ({
                ...x,
                status: v,
                arrived_at: v === 'visited' && !x.arrived_at && phase === 'ongoing' ? dayjs().format('YYYY-MM-DDTHH:mm') : x.arrived_at,
              }))
            }
            options={[
              { value: 'todo', label: '待前往' },
              { value: 'visited', label: '已打卡' },
              { value: 'skipped', label: '跳过' },
            ]}
          />
        </Field>
      )}

      {showExperience && (
        <>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-700">体验如何</span>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(verdicts) as Exclude<Verdict, ''>[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set('verdict', f.verdict === v ? '' : v)}
                  className={cn(
                    'rounded-full px-3 py-1 text-sm ring-1 transition',
                    f.verdict === v ? verdicts[v].cls + ' font-semibold ring-2' : 'bg-white text-ink-500 ring-ink-200',
                  )}
                >
                  {verdicts[v].emoji} {verdicts[v].label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-ink-700">
              评分 <Stars value={f.rating} onChange={(v) => set('rating', v)} size={20} />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              人均 ¥
              <Input
                type="number"
                min={0}
                value={f.cost || ''}
                onChange={(e) => set('cost', Number(e.target.value) || 0)}
                className="h-8 w-24"
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          loading={saving}
          onClick={() =>
            onSave({
              // 只在用户改了名称时提交：原样回传自动生成的名称会被当成用户命名，进而新建地点（清空则恢复自动命名）
              name: f.name.trim() !== w.name ? f.name.trim() : undefined,
              address: f.address,
              category: f.category,
              day: f.day,
              note: f.note,
              verdict: f.verdict,
              rating: f.rating,
              cost: f.cost,
              planned_at: w.planned ? fromLocal(f.planned_at) : undefined,
              arrived_at: phase !== 'planning' || !w.planned ? fromLocal(f.arrived_at) : undefined,
              status: w.planned && phase !== 'planning' ? f.status : undefined,
            })
          }
        >
          保存
        </Button>
      </div>
    </div>
  )
}
