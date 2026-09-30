/**
 * 编辑页的协同界面：谁在编辑、未保存的修改、别人刚保存了修改、冲突对比、恢复上次的草稿、离开前确认
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  ArrowUpDown,
  Bed,
  Check,
  CloudOff,
  History,
  Loader2,
  Minus,
  PenLine,
  Plus,
  RefreshCw,
  Settings2,
  Users,
  X,
} from 'lucide-react'
import type { TripDetail, TripEditor, UserBrief } from '@/api'
import { Avatar, Button, Modal } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fromNow } from '@/lib/format'
import { diffPlan, overlapping, type PlanChange } from './planDraft'
import type { PlanConflictState, SaveState } from './usePlanEditor'
import { poolNameOf } from './usePlanEditor'

const who = (u: Pick<UserBrief, 'nickname' | 'username'> | null | undefined) => (u ? u.nickname || u.username : '')

/** 「10:32」（今天）或「9月28日 10:32」 */
function when(t: string | null | undefined) {
  if (!t) return ''
  const d = dayjs(t)
  return d.isSame(dayjs(), 'day') ? d.format('HH:mm') : d.format('M月D日 HH:mm')
}

/* ---------------- 谁在编辑 ---------------- */

/** 头像 + 「小梅 正在编辑」：同一时间有别的成员打开了编辑页 */
export function PresenceBadge({ editors, className }: { editors: TripEditor[]; className?: string }) {
  if (!editors.length) return null
  const names = editors.map((e) => who(e.user))
  const text = names.length === 1 ? `${names[0]} 正在编辑` : names.length === 2 ? `${names[0]}、${names[1]} 正在编辑` : `${names[0]} 等 ${names.length} 人正在编辑`
  return (
    <div
      className={cn('inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full border border-ink-200 bg-surface pr-3 pl-1 text-[12.5px] text-ink-900', className)}
      title={editors.map((e) => `${who(e.user)}：${when(e.since)} 起在编辑`).join('\n')}
      aria-live="polite"
    >
      <span className="flex -space-x-2">
        {editors.slice(0, 3).map((e) => (
          <Avatar key={e.user.id} user={e.user} size={24} ring />
        ))}
      </span>
      <span aria-hidden className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-600" />
      </span>
      <span className="truncate">{text}</span>
    </div>
  )
}

/** 别人也在编辑时的一句说明：怎么避免互相覆盖 */
export function CoEditHint({ editors, onClose }: { editors: TripEditor[]; onClose: () => void }) {
  if (!editors.length) return null
  return (
    <div className="flex items-start gap-3 rounded-md border border-ink-200 bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-700">
      <Users className="mt-0.5 size-4 shrink-0 text-ink-500" strokeWidth={1.5} />
      <p className="min-w-0 flex-1">
        <span className="text-ink-900">{who(editors[0].user)}</span>
        {editors.length > 1 ? ` 等 ${editors.length} 人` : ''} 也在编辑。修改在点「保存」前只在各自这里；后保存的一方会先看到双方改了什么，再决定保留哪一份。
      </p>
      <button type="button" onClick={onClose} className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-400 hover:text-ink-900" aria-label="知道了">
        <X className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  )
}

/* ---------------- 保存状态 ---------------- */

/** 标题下的一行：未保存的修改 N 处（点开看是哪些）· 放弃；保存中；保存失败 */
export function DraftStatus({
  state,
  count,
  onShow,
  onDiscard,
  className,
}: {
  state: SaveState
  count: number
  onShow: () => void
  onDiscard: () => void
  className?: string
}) {
  return (
    <div className={cn('flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]', className)} aria-live="polite">
      {state === 'saving' ? (
        <span className="inline-flex items-center gap-1.5 text-ink-500">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          正在保存…
        </span>
      ) : count > 0 ? (
        <>
          <button type="button" onClick={onShow} className="inline-flex items-center gap-2 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
            <span aria-hidden className={cn('size-2 rounded-full', state === 'error' ? 'bg-red-600' : 'bg-brand-500')} />
            {state === 'error' ? '没有保存成功 · ' : ''}未保存的修改 <span className="font-num text-[13px]">{count}</span> 处
          </button>
          <button type="button" onClick={onDiscard} className="text-ink-500 underline-offset-4 hover:text-ink-900 hover:underline">
            放弃修改
          </button>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-ink-500">
          <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
          全部已保存
        </span>
      )}
    </div>
  )
}

/* ---------------- 别人刚保存了修改 ---------------- */

/** 本地有未保存的修改时，别人保存了新版本：不打断编辑，给「查看」 */
export function RemoteNotice({
  by,
  at,
  meId,
  onView,
  onDismiss,
}: {
  by: UserBrief | null
  at: string
  meId: number
  onView: () => void
  onDismiss: () => void
}) {
  const text = by?.id === meId ? '你在其他页面或设备上保存了修改' : by ? `${who(by)} 刚刚保存了修改` : '有人刚刚保存了修改'
  return (
    <div role="status" className="animate-fade-in flex items-center gap-3 rounded-md border border-brand-300 bg-brand-50 py-2 pr-2 pl-3.5 text-[13px] text-ink-900">
      {by ? <Avatar user={by} size={24} /> : <RefreshCw className="size-4 shrink-0 text-brand-600" strokeWidth={1.5} />}
      <p className="min-w-0 flex-1 leading-snug">
        {text}
        <span className="ml-1.5 text-[12px] text-ink-500">{when(at)}</span>
        <span className="block text-[12px] text-ink-600">你还有没保存的修改，保存前先看看双方都改了什么</span>
      </p>
      <Button size="sm" variant="outline" onClick={onView} className="shrink-0">
        查看
      </Button>
      <button type="button" onClick={onDismiss} className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-500 hover:text-ink-900" aria-label="稍后再说">
        <X className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  )
}

/** 没有未保存的修改时，别人的修改已经同步过来：几秒后消失 */
export function SyncedNote({ synced, onDone }: { synced: { by: UserBrief; text: string; count: number; at: number } | null; onDone: () => void }) {
  useEffect(() => {
    if (!synced) return
    const t = setTimeout(onDone, 6000)
    return () => clearTimeout(t)
  }, [synced, onDone])
  if (!synced) return null
  return (
    <p role="status" className="animate-fade-in flex items-center gap-2 text-[12.5px] text-ink-600">
      <Avatar user={synced.by} size={20} />
      <span className="min-w-0 truncate">
        已同步 <span className="text-ink-900">{who(synced.by)}</span> 的修改：{synced.text}
        {synced.count > 1 ? ` 等 ${synced.count} 处` : ''}
      </span>
    </p>
  )
}

/* ---------------- 修改清单 ---------------- */

const KIND_ICON: Record<PlanChange['kind'], typeof Plus> = {
  trip: Settings2,
  add: Plus,
  remove: Minus,
  move: ArrowRightLeft,
  rename: PenLine,
  edit: PenLine,
  order: ArrowUpDown,
  lodging: Bed,
}

export function ChangeList({ changes, both, empty, limit = 40 }: { changes: PlanChange[]; both?: Set<string>; empty: ReactNode; limit?: number }) {
  if (!changes.length) return <p className="py-2 text-[13px] text-ink-500">{empty}</p>
  const shown = changes.slice(0, limit)
  return (
    <ul className="divide-y divide-ink-200">
      {shown.map((c) => {
        const Icon = KIND_ICON[c.kind]
        const hot = both?.has(c.key)
        return (
          <li key={c.key} className="flex items-start gap-2.5 py-2 text-[13.5px] leading-snug text-ink-900">
            <Icon
              className={cn('mt-0.5 size-3.5 shrink-0', c.kind === 'remove' ? 'text-red-600' : c.kind === 'add' ? 'text-emerald-600' : 'text-ink-500')}
              strokeWidth={1.75}
            />
            <span className="min-w-0 flex-1">{c.text}</span>
            {hot && <span className="shrink-0 rounded-full border border-amber-600/40 bg-amber-50 px-2 py-px text-[11px] text-amber-700">双方都改了</span>}
            {!hot && c.soft && <span className="shrink-0 text-[11px] text-ink-400">打卡记录</span>}
          </li>
        )
      })}
      {changes.length > shown.length && <li className="py-2 text-[12px] text-ink-500">还有 {changes.length - shown.length} 处…</li>}
    </ul>
  )
}

/** 「未保存的修改」清单：放弃或保存 */
export function ChangesDialog({
  open,
  changes,
  saving,
  onClose,
  onSave,
  onDiscard,
}: {
  open: boolean
  changes: PlanChange[]
  saving: boolean
  onClose: () => void
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="未保存的修改"
      footer={
        <>
          <Button variant="ghost" onClick={onDiscard} disabled={saving || !changes.length} className="mr-auto text-red-700">
            放弃这些修改
          </Button>
          <Button variant="outline" onClick={onClose}>
            继续编辑
          </Button>
          <Button onClick={onSave} loading={saving} disabled={!changes.length}>
            保存
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] leading-relaxed text-ink-500">这些修改只在你这里（也暂存在这台设备上），点「保存」后同行的人才能看到。</p>
      <ChangeList changes={changes} empty="没有未保存的修改" />
    </Modal>
  )
}

/* ---------------- 冲突 ---------------- */

/**
 * 别人保存了新版本、自己也有没保存的修改：双方各改了什么（双方都改了的地方标出来），
 * 选择「载入对方的版本（放弃我的修改）」或「用我的版本覆盖」
 */
export function ConflictDialog({
  conflict,
  base,
  draft,
  meId,
  saving,
  onLoadTheirs,
  onOverwrite,
  onClose,
}: {
  conflict: PlanConflictState | null
  base: TripDetail | null
  draft: TripDetail | null
  meId: number
  saving: boolean
  onLoadTheirs: () => void
  onOverwrite: () => void
  onClose: () => void
}) {
  const data = useMemo(() => {
    if (!conflict || !base || !draft) return null
    const pn = poolNameOf(draft)
    const theirs = diffPlan(base, conflict.remote, pn)
    const mine = diffPlan(base, draft, pn)
    return { theirs, mine, bothTheirs: overlapping(mine, theirs), bothMine: overlapping(theirs, mine) }
  }, [conflict, base, draft])
  const open = !!conflict && !!data
  const byMe = conflict?.by?.id === meId
  const name = byMe ? '你（在其他页面或设备上）' : conflict?.by ? who(conflict.by) : '同行的人'
  // 覆盖会撤销的：计划的修改（打卡进度一类的 soft 修改保留，包括对方删掉的打卡记录——覆盖也不会把它们建回来）
  const lost = data ? data.theirs.filter((c) => !c.soft) : []
  const added = data ? data.theirs.filter((c) => c.kind === 'add' && !c.soft).length : 0
  const removedHistory = data ? data.theirs.filter((c) => c.soft && c.key.startsWith('rm:')).length : 0
  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      wide
      title={
        <span className="flex items-center gap-2.5">
          <History className="size-5 shrink-0 text-brand-600" strokeWidth={1.5} />
          {byMe ? '这段旅程在别处保存过' : `${name} 也修改了这段旅程`}
        </span>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="outline" onClick={onLoadTheirs} disabled={saving}>
            载入对方的版本（放弃我的修改）
          </Button>
          <Button onClick={onOverwrite} loading={saving}>
            用我的版本覆盖
          </Button>
        </div>
      }
    >
      {data && conflict && (
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-md bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-ink-700">
            {conflict.by ? <Avatar user={conflict.by} size={32} /> : <Users className="size-5 text-ink-500" strokeWidth={1.5} />}
            <p className="min-w-0">
              <span className="text-ink-900">{name}</span> 在 <span className="font-num text-ink-900">{when(conflict.at)}</span>
              <span className="text-ink-500">（{fromNow(conflict.at)}）</span>保存了新的版本；你的修改是在那之前的版本上做的，还没有保存。
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <section>
              <h4 className="mb-1 text-[12.5px] font-medium tracking-[0.04em] text-ink-900">
                {byMe ? '另一处保存的修改' : `${name} 的修改`}
                <span className="font-num ml-2 text-[13px] text-ink-500">{data.theirs.length}</span>
              </h4>
              <ChangeList changes={data.theirs} both={data.bothTheirs} empty="计划没有变化（只是打卡、照片等）" />
            </section>
            <section>
              <h4 className="mb-1 text-[12.5px] font-medium tracking-[0.04em] text-ink-900">
                我还没保存的修改<span className="font-num ml-2 text-[13px] text-ink-500">{data.mine.length}</span>
              </h4>
              <ChangeList changes={data.mine} both={data.bothMine} empty="没有未保存的修改" />
            </section>
          </div>
          <ul className="space-y-1.5 border-t border-ink-200 pt-4 text-[12.5px] leading-relaxed text-ink-600">
            <li>
              <span className="text-ink-900">载入对方的版本</span>：换成{byMe ? '最新' : '对方'}保存的版本，你这里没保存的修改会丢掉。
            </li>
            <li>
              <span className="text-ink-900">用我的版本覆盖</span>
              {`：以你现在看到的为准保存${lost.length ? `，${byMe ? '那边' : '对方'}的 ${lost.length} 处修改会被撤销${added ? `（包括新增的 ${added} 个地点）` : ''}` : ''}。`}
              {`打卡记录不受影响：${byMe ? '那边' : '对方'}新的打卡、照片和写的评价都保留${removedHistory ? `，删掉的 ${removedHistory} 条打卡记录也不会恢复` : ''}。`}
            </li>
          </ul>
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 恢复上次的草稿 ---------------- */

/**
 * 上次没保存的修改：恢复，或明确选「不用了」才丢掉。按 Esc、点背景（手机上是底部面板，很容易碰到）只是先关上，
 * 草稿留着，标题下有「恢复上次没保存的修改」，下次打开编辑页也还会问
 */
export function RestoreDialog({
  open,
  savedAt,
  changes,
  onRestore,
  onDrop,
  onLater,
}: {
  open: boolean
  savedAt: number
  changes: PlanChange[]
  onRestore: () => void
  onDrop: () => void
  onLater: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onLater}
      title={
        <span className="flex items-center gap-2.5">
          <CloudOff className="size-5 shrink-0 text-brand-600" strokeWidth={1.5} />
          有上次没保存的修改
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onDrop} className="mr-auto text-red-700">
            不用了，丢掉
          </Button>
          <Button variant="outline" onClick={onLater}>
            稍后再说
          </Button>
          <Button onClick={onRestore}>恢复这些修改</Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] leading-relaxed text-ink-500">
        {fromNow(new Date(savedAt).toISOString())}你在这台设备上改了 {changes.length} 处，页面关闭前没有保存。恢复后记得点「保存」；如果期间别人也改过，保存时会先让你对比。
        先关掉也不会丢：点标题下的「恢复上次没保存的修改」就能再打开。
      </p>
      <ChangeList changes={changes} empty="" limit={8} />
    </Modal>
  )
}

/* ---------------- 离开前 ---------------- */

export function LeaveDialog({
  open,
  count,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: {
  open: boolean
  count: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={() => !saving && onCancel()}
      title={`还有 ${count} 处修改没有保存`}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            继续编辑
          </Button>
          <Button variant="outline" onClick={onDiscard} disabled={saving}>
            不保存，离开
          </Button>
          <Button onClick={onSave} loading={saving}>
            保存并离开
          </Button>
        </div>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-600">保存后同行的人才能看到这些修改。不保存的话，这些修改会被丢掉。</p>
    </Modal>
  )
}
