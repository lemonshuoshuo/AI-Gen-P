// 空间「我们」的公共部件：类型、徽章、成员头像、邀请卡片、空间切换条，以及空间数据的查询与刷新
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { Check, Heart, House, LayoutGrid, Plus, Sparkles, Tag, Users, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Space, type SpaceDetail, type SpaceInvite, type SpaceRef, type SpaceType, type UserBrief } from '@/api'
import { Avatar, Button, ChoiceChip, OptionGroup, selectedClass } from '@/components/ui'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { beijingToday, dayjs, fromNow } from '@/lib/format'
import { useAuth } from '@/stores/auth'

/* ---------------- 类型 ---------------- */

export interface SpaceTypeMeta {
  value: SpaceType
  /** 与服务端的 type_label 一致（自定义类型除外） */
  label: string
  en: string
  icon: LucideIcon
  /** 创建时不填名称的默认名（与服务端一致；自定义类型为类型名称） */
  defaultName: string
  /** 一句话说明 */
  hint: string
}

export const SPACE_TYPES: SpaceTypeMeta[] = [
  { value: 'couple', label: '情侣', en: 'Couple', icon: Heart, defaultName: '我们', hint: '两个人的空间，记下在一起的纪念日' },
  { value: 'besties', label: '闺蜜', en: 'Besties', icon: Sparkles, defaultName: '闺蜜们', hint: '说走就走的姐妹局' },
  { value: 'friends', label: '朋友', en: 'Friends', icon: Users, defaultName: '朋友们', hint: '同学、室友、老朋友' },
  { value: 'family', label: '家人', en: 'Family', icon: House, defaultName: '家人们', hint: '带上爸妈和孩子' },
  { value: 'custom', label: '自定义', en: 'Custom', icon: Tag, defaultName: '', hint: '驴友团、球队、同事……自己起个名' },
]

export const spaceTypeOf = (t: SpaceType | string | undefined): SpaceTypeMeta =>
  SPACE_TYPES.find((x) => x.value === t) ?? SPACE_TYPES[SPACE_TYPES.length - 1]

/** 空间类型的小图标（胭脂色：全站「我们」的颜色） */
export function SpaceTypeIcon({ type, className }: { type: SpaceType | string; className?: string }) {
  const Icon = spaceTypeOf(type).icon
  return <Icon aria-hidden className={cn('size-3.5 shrink-0 text-pink-600', className)} strokeWidth={1.75} />
}

/** 类型徽章：细线胶囊 + 类型图标 + 类型名称（自定义类型显示它自己的名字） */
export function SpaceTypeBadge({ space, className }: { space: Pick<SpaceRef, 'type' | 'type_label'>; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-[12px] leading-none whitespace-nowrap text-ink-700',
        className,
      )}
    >
      <SpaceTypeIcon type={space.type} className="size-3" />
      {space.type_label || spaceTypeOf(space.type).label}
    </span>
  )
}

/** 类型选择：单选胶囊，选中是实心强调色 + 勾；disabled 给出不能选的原因 */
export function SpaceTypeChooser({
  value,
  onChange,
  disabled,
  className,
}: {
  value: SpaceType
  onChange: (t: SpaceType) => void
  disabled?: Partial<Record<SpaceType, string>>
  className?: string
}) {
  return (
    <OptionGroup label="空间类型" className={cn('flex flex-wrap gap-2', className)}>
      {SPACE_TYPES.map((t) => {
        const Icon = t.icon
        const why = disabled?.[t.value]
        return (
          <ChoiceChip
            key={t.value}
            role="radio"
            selected={value === t.value}
            disabled={!!why}
            title={why}
            icon={<Icon aria-hidden />}
            onClick={() => onChange(t.value)}
            className="h-9 px-3.5 text-[13.5px]"
          >
            {t.label}
          </ChoiceChip>
        )
      })}
    </OptionGroup>
  )
}

/* ---------------- 成员 ---------------- */

/** 叠放的成员头像：创建者在最上；超出 max 的显示 +N */
export function MemberStack({
  users,
  size = 32,
  max = 5,
  className,
  ringClass = 'ring-paper',
}: {
  users: Pick<UserBrief, 'id' | 'nickname' | 'username' | 'avatar_url'>[]
  size?: number
  max?: number
  className?: string
  /** 头像外圈的颜色（与所在底色一致，叠放时像剪纸） */
  ringClass?: string
}) {
  const faces = users.slice(0, max)
  const more = users.length - faces.length
  const overlap = Math.round(size * 0.3)
  return (
    <span className={cn('flex shrink-0 items-center', className)}>
      {faces.map((u, i) => (
        <span key={u.id} className="relative flex shrink-0 rounded-full" style={{ marginLeft: i ? -overlap : 0, zIndex: faces.length - i }}>
          <Avatar user={u} size={size} className={cn('ring-2', ringClass)} />
        </span>
      ))}
      {more > 0 && (
        // 压在最后一个头像下面：多出来的宽度被盖住，「+N」在露出来的部分居中，不会被头像挡住
        <span
          className={cn('font-num relative flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-700 ring-2', ringClass)}
          style={{ width: size + overlap, height: size, marginLeft: -overlap, paddingLeft: overlap, fontSize: Math.max(10, size * 0.36) }}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

const nameOf = (u: Pick<UserBrief, 'nickname' | 'username'>) => u.nickname || u.username

/** 成员名字：两个人「A & B」，更多时「A、B、C 等 5 人」 */
export function memberNames(users: Pick<UserBrief, 'nickname' | 'username'>[], max = 3) {
  if (users.length <= 2) return users.map(nameOf).join(' & ')
  const shown = users.slice(0, max).map(nameOf).join('、')
  return users.length > max ? `${shown} 等 ${users.length} 人` : shown
}

/** 纪念日到今天是第几天（纪念日当天为第 1 天，北京时间）；没有或晚于今天时为 null */
export function daysSince(date: string | null | undefined) {
  if (!date) return null
  const n = dayjs(beijingToday()).diff(dayjs(date), 'day') + 1
  return n > 0 ? n : null
}

/** 纪念日计数的说法：情侣「在一起」，其他空间「纪念日」 */
export const anniversaryLabel = (type: SpaceType) => (type === 'couple' ? '在一起' : '纪念日')

/* ---------------- 查询与刷新 ---------------- */

/** 我所在的空间（按加入的先后） */
export function useSpaces(enabled = true) {
  const user = useAuth((s) => s.user)
  return useQuery({ queryKey: ['spaces'], queryFn: api.spaces.list, enabled: enabled && !!user })
}

/** 待回应的空间邀请：别人邀请我的、我发出的 */
export function useSpaceInvites(opts: { poll?: boolean } = {}) {
  const user = useAuth((s) => s.user)
  return useQuery({
    queryKey: ['space-invites'],
    queryFn: api.spaces.invites,
    enabled: !!user,
    staleTime: 60_000,
    refetchInterval: opts.poll ? 120_000 : false,
  })
}

/**
 * 空间的成员关系变了（创建、加入、退出、移除、删除、改设置）：空间列表与详情、邀请、情侣信息、
 * 通知上的「接受 / 婉拒」按钮都要刷新；trips 为 true 时旅程列表、足迹也刷新（能看到的旅程变了）
 */
export function refreshSpaces(qc: QueryClient, opts: { trips?: boolean; notifications?: boolean } = {}) {
  const keys = ['spaces', 'space', 'space-invites', 'space-footprints', 'space-trips', 'partner', 'unread']
  // 通知页自己在处理邀请时不刷新列表：刚点完「接受」的那条要留在原处显示结果
  if (opts.notifications !== false) keys.push('notifications')
  for (const key of keys) void qc.invalidateQueries({ queryKey: [key] })
  void qc.invalidateQueries({ queryKey: ['me', 'invites'] })
  // 个人主页上的情侣、Me 的 partner / default_space_id
  void qc.invalidateQueries({ queryKey: ['user'] })
  void useAuth.getState().refreshMe()
  if (opts.trips) {
    void invalidateTripLists(qc)
    void qc.invalidateQueries({ queryKey: ['trip'] })
  }
}

/** 把默认空间设为 id（null 清除）：更新本地的 Me 与各处的 is_default */
export async function setDefaultSpace(qc: QueryClient, id: number | null) {
  const me = await api.me.setDefaultSpace(id)
  useAuth.getState().setUser(me)
  qc.setQueryData<Space[]>(['spaces'], (list) => list?.map((s) => ({ ...s, is_default: s.id === id })))
  qc.setQueriesData<SpaceDetail>({ queryKey: ['space'] }, (d) => (d ? { ...d, is_default: d.id === id } : d))
  return me
}

/* ---------------- 空间切换条 ---------------- */

/**
 * 空间页顶部的切换条：「全部空间」（总览；有待我回应的邀请时带数字）、我的每个空间（当前的是实心胶囊 + 勾）、「新建」。
 * 从默认空间也能一眼看到别的空间、回到总览；手机上横向滑动，当前空间自动滚进视野
 */
export function SpaceSwitcher({ current, className }: { current: number; className?: string }) {
  const spaces = useSpaces().data
  const incoming = useSpaceInvites().data?.incoming.length ?? 0
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    const box = el?.closest('nav')
    if (!el || !box || box.scrollWidth <= box.clientWidth) return
    // 只滚动切换条本身（scrollIntoView 会连整页一起滚），而且只在当前空间没露全时才滚：
    // 「全部空间」在最前面，能不挪就不挪
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    // 左边被钉住的「全部空间」挡着的部分也算看不到
    const left = (listRef.current?.firstElementChild?.getBoundingClientRect().right ?? b.left) + 8
    const pad = 24
    // 比露出来的宽度还宽的胶囊（名字很长）：左边对齐钉住的「全部空间」，勾和名字的开头不会被挡住
    if (r.width > b.right - pad - left || r.left < left) box.scrollLeft -= left - r.left
    else if (r.right > b.right - pad) box.scrollLeft += r.right - b.right + pad
  }, [current, spaces?.length])
  if (!spaces) return <div aria-hidden className={cn('h-10', className)} />
  const chip = 'h-9 gap-1.5 px-3.5 text-[13px]'
  return (
    <nav aria-label="切换空间" className={cn('-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:-mx-8 md:px-8 [&::-webkit-scrollbar]:hidden', className)}>
      <ul ref={listRef} className="flex w-max items-center gap-2 py-0.5">
        {/* 「全部空间」钉在左边：横向滑动时也一直看得到（粘性定位的边界是 nav 的内容区，所以 left 要减去 nav 的内边距） */}
        <li className="sticky -left-4 z-10 -ml-4 flex items-center gap-2.5 bg-paper pr-0.5 pl-4 md:-left-8 md:-ml-8 md:pl-8">
          <Link to="/spaces" className={selectedClass(false, 'chip', chip)}>
            <LayoutGrid aria-hidden strokeWidth={1.75} />
            全部空间
            {incoming > 0 && (
              <>
                <span aria-hidden className="font-num ml-0.5 min-w-[18px] rounded-full bg-brand-fill px-1.5 text-center text-[11px] leading-[18px] font-semibold text-on-brand">
                  {incoming}
                </span>
                <span className="sr-only">（{incoming} 个待回应的邀请）</span>
              </>
            )}
          </Link>
          <span aria-hidden className="h-5 w-px bg-line" />
        </li>
        {spaces.map((s) => {
          const on = s.id === current
          return (
            <li key={s.id}>
              <Link
                to={`/spaces/${s.id}`}
                aria-current={on ? 'page' : undefined}
                title={`${s.name} · ${s.type_label}${s.is_default ? ' · 默认空间' : ''}`}
                // 手机上窄一些：当前空间的胶囊总能完整露在钉住的「全部空间」右边
                className={selectedClass(on, 'chip', cn(chip, 'max-w-[10rem] sm:max-w-[15rem]'))}
              >
                {on ? <Check aria-hidden strokeWidth={2.75} /> : <SpaceTypeIcon type={s.type} />}
                <span className="truncate">{s.name}</span>
              </Link>
            </li>
          )
        })}
        <li>
          <Link to="/spaces?new=1" className={selectedClass(false, 'chip', cn(chip, 'border-dashed'))}>
            <Plus aria-hidden strokeWidth={1.75} />
            新建
          </Link>
        </li>
      </ul>
    </nav>
  )
}

/* ---------------- 收到的邀请 ---------------- */

/** 人名：展示字体（只有 400 字重，不加粗） */
const B = ({ children }: { children: ReactNode }) => <span className="font-display text-ink-900">{children}</span>

/**
 * 收到的一条空间邀请：谁邀请、哪个空间（类型、现在有谁）、留言，以及「婉拒 / 接受」。
 * onDone：处理完（accepted 为 true 时带上加入后的空间）
 */
export function IncomingInviteCard({
  invite,
  onDone,
  className,
}: {
  invite: SpaceInvite
  onDone?: (accepted: boolean, space?: SpaceDetail) => void
  className?: string
}) {
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const s = invite.space
  const act = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline')
    try {
      if (accept) {
        const d = await api.spaces.accept(invite.id)
        toast.success(`已加入「${d.name}」`)
        onDone?.(true, d)
      } else {
        await api.spaces.decline(invite.id)
        toast.success('已婉拒邀请')
        onDone?.(false)
      }
    } catch (e) {
      toast.error(errorMessage(e))
      // 邀请可能已被撤回或在别处处理：刷新后这张卡片会消失
      onDone?.(false)
    } finally {
      setBusy(null)
    }
  }
  return (
    <article className={cn('th-card flex flex-col p-4 md:p-5', className)}>
      <div className="flex items-start gap-3">
        <Avatar user={invite.inviter} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-snug text-ink-700">
            <B>{nameOf(invite.inviter)}</B> 邀请你加入
          </p>
          <p className="font-display text-card mt-1 truncate text-ink-900">{s.name}</p>
        </div>
        <span className="caption shrink-0">{fromNow(invite.created_at)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 pl-[52px]">
        <SpaceTypeBadge space={s} />
        {s.members.length > 0 && (
          <span className="flex min-w-0 items-center gap-2">
            <MemberStack users={s.members} size={22} max={4} ringClass="ring-surface" />
            <span className="caption truncate">{s.member_count} 人</span>
          </span>
        )}
      </div>
      {s.description && <p className="caption mt-2 pl-[52px]">{s.description}</p>}
      {invite.message && (
        <p className="font-display mt-3 ml-[52px] border-l-2 border-pink-500 py-0.5 pl-3 text-[15px] leading-relaxed break-words text-ink-800">
          “{invite.message}”
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={!!busy} loading={busy === 'decline'} onClick={() => act(false)}>
          婉拒
        </Button>
        <Button disabled={!!busy} loading={busy === 'accept'} icon={<Check className="size-4" strokeWidth={2} />} onClick={() => act(true)}>
          接受邀请
        </Button>
      </div>
    </article>
  )
}
