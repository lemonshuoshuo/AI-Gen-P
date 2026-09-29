import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Space, type TripDetail } from '@/api'
import { Avatar, Button, CheckBadge, Modal, OptionGroup, Spinner, confirmDialog, selectedClass } from '@/components/ui'
import { invalidateTripLists } from '@/lib/cache'
import { useAuth } from '@/stores/auth'
import { MemberStack, SpaceTypeIcon, memberNames, refreshSpaces, useSpaces } from '@/components/space'

/** 选项卡片（单选）：左侧头像、中间名称 + 一行说明、右上角勾选徽章；选中是强调色描边 + 底纹 + 实心勾 */
function PickOption({
  selected,
  onClick,
  title,
  sub,
  lead,
  icon,
  disabled,
}: {
  selected: boolean
  onClick: () => void
  title: ReactNode
  sub: ReactNode
  lead: ReactNode
  icon?: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={selectedClass(selected, 'card', 'flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left')}
    >
      {lead}
      <span className="min-w-0 flex-1">
        <span className="th-option-title flex min-w-0 items-center gap-1.5 text-[15px] leading-snug">
          {icon}
          <span className="truncate">{title}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-ink-500">{sub}</span>
      </span>
      <CheckBadge />
    </button>
  )
}

/** 选了某个空间后，这段旅程对谁开放 */
export function spaceEffect(space: Space | null | undefined, none = '只有你能编辑；之后可以在旅程的「成员」里邀请同行的人') {
  if (!space) return none
  if (space.type === 'couple')
    return space.member_count > 1 ? `你们两人都能编辑，它会出现在「${space.name}」的共同足迹里` : `TA 加入「${space.name}」后就能一起编辑`
  return space.member_count > 1
    ? `「${space.name}」的 ${space.member_count} 位成员都能查看、编辑和打卡，它会出现在空间的足迹里`
    : `之后加入「${space.name}」的人都能查看、编辑和打卡`
}

const NEW_TRIP_NONE = { title: '只有我', sub: '之后也可以邀请同行的人', effect: '只有你能编辑；之后可以在旅程的「成员」里邀请同行的人' }
const TRIP_NONE = { title: '不放进空间', sub: '只有作者和共同作者能编辑', effect: '只有作者和共同作者能查看和编辑（按旅程的可见范围）' }

/**
 * 「和谁一起」：只有我 / 我的各个空间（单选）。spaces 为空时提示去建一个空间
 */
export function SpacePicker({
  spaces,
  value,
  onChange,
  loading,
  none = NEW_TRIP_NONE,
  className,
}: {
  spaces: Space[] | undefined
  value: number | null
  onChange: (id: number | null) => void
  loading?: boolean
  /** 「不属于任何空间」这一项的文字 */
  none?: { title: string; sub: string; effect: string }
  className?: string
}) {
  const me = useAuth((s) => s.user)!
  const picked = spaces?.find((s) => s.id === value) ?? null
  return (
    <div className={className}>
      <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">和谁一起</span>
      {loading ? (
        <div className="flex h-16 items-center gap-2 text-[13px] text-ink-500">
          <Spinner className="size-4" />
          正在读取你的空间…
        </div>
      ) : (
        <>
          <OptionGroup label="和谁一起" className="grid gap-2 sm:grid-cols-2">
            <PickOption
              selected={!picked}
              onClick={() => onChange(null)}
              lead={<Avatar user={me} size={30} />}
              title={none.title}
              sub={none.sub}
            />
            {spaces?.map((s) => (
              <PickOption
                key={s.id}
                selected={picked?.id === s.id}
                onClick={() => onChange(s.id)}
                lead={<MemberStack users={s.members} size={30} max={3} ringClass="ring-surface" />}
                icon={<SpaceTypeIcon type={s.type} />}
                title={s.name}
                sub={`${s.type_label} · ${memberNames(s.members)}`}
              />
            ))}
          </OptionGroup>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">{spaceEffect(picked, none.effect)}</p>
          {spaces && spaces.length === 0 && (
            <Link
              to="/spaces?new=1"
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
            >
              建一个空间，和情侣、闺蜜或家人一起规划
              <ArrowRight className="size-3.5" strokeWidth={1.5} />
            </Link>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 旅程所属的空间：作者可以加入、更换或移出；空间创建者（不是作者）只能把它移出自己的空间。
 * onChanged(null)：移出后自己已看不到这段旅程
 */
export function TripSpaceDialog({
  trip,
  onClose,
  onChanged,
}: {
  trip: TripDetail
  onClose: () => void
  onChanged: (t: TripDetail | null) => void
}) {
  const qc = useQueryClient()
  const spacesQ = useSpaces()
  const current = trip.space?.id ?? null
  const [value, setValue] = useState<number | null>(current)
  const [saving, setSaving] = useState(false)
  // 不是作者：只有空间创建者能移出
  const ownerOnly = !trip.is_owner

  const save = async (next: number | null) => {
    if (next === current) return onClose()
    if (next == null && ownerOnly) {
      const ok = await confirmDialog({
        title: `把《${trip.title}》移出「${trip.space?.name}」？`,
        desc: '移出后空间成员不再能查看和编辑它（共同作者不受影响）；你不是它的作者，也会看不到它。',
        okText: '移出空间',
        danger: true,
      })
      if (!ok) return
    }
    setSaving(true)
    try {
      const r = await api.trips.update(trip.id, { space_id: next ?? 0 })
      const target = spacesQ.data?.find((s) => s.id === next)
      toast.success(next == null ? `已移出「${trip.space?.name ?? '空间'}」` : `已加入「${target?.name ?? '空间'}」`)
      void invalidateTripLists(qc)
      refreshSpaces(qc)
      onChanged(r && typeof r === 'object' && 'id' in r ? r : null)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={ownerOnly ? '移出空间' : '这段旅程属于哪个空间'}
      onClose={() => !saving && onClose()}
      className="sm:max-w-xl"
      footer={
        ownerOnly ? (
          <>
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button variant="danger" loading={saving} onClick={() => save(null)}>
              移出空间
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button loading={saving} disabled={value === current || spacesQ.isLoading} onClick={() => save(value)}>
              {value == null && current != null ? '移出空间' : '保存'}
            </Button>
          </>
        )
      }
    >
      {ownerOnly ? (
        <p className="text-sm leading-relaxed text-ink-500">
          《{trip.title}》是 {trip.author.nickname || trip.author.username} 的旅程，关联在你创建的空间「{trip.space?.name}」里。作为空间的创建者，你可以把它移出空间。
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[13.5px] leading-relaxed text-ink-500">加入空间后，空间的全部成员都能查看、编辑和打卡（和共同作者一样），它会出现在空间的足迹里；随时可以移出。</p>
          <SpacePicker spaces={spacesQ.data} value={value} onChange={setValue} loading={spacesQ.isLoading} none={TRIP_NONE} />
        </div>
      )}
    </Modal>
  )
}
