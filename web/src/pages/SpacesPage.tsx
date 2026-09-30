import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Space, type SpaceType, type TripBrief } from '@/api'
import { LabelRow, cityShort } from '@/components/editorial'
import {
  IncomingInviteCard,
  MemberStack,
  SPACE_TYPES,
  SpaceTypeBadge,
  anniversaryLabel,
  daysSince,
  memberNames,
  refreshSpaces,
  setDefaultSpace,
  useSpaceInvites,
  useSpaces,
} from '@/components/space'
import { CreateSpaceDialog } from '@/components/space/CreateSpaceDialog'
import { Avatar, Button, LoadError, selectedClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { cn } from '@/lib/cn'
import { dateRange, fromNow } from '@/lib/format'
import { phases } from '@/lib/meta'
import { useAuth } from '@/stores/auth'

const isSpaceType = (v: string | null): v is SpaceType => SPACE_TYPES.some((t) => t.value === v)

/** 卡片上的一格数字：小标签 + 等高数字 + 单位 */
function Fact({ label, value, unit, className }: { label: string; value: number | string; unit: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[11.5px] tracking-[0.06em] text-ink-500">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1">
        <span className="font-num text-[22px] leading-none text-ink-900">{value}</span>
        <span className="text-[11.5px] text-ink-500">{unit}</span>
      </dd>
    </div>
  )
}

/** 最近的一次旅程：小封面 + 标题 + 日期 / 阶段 */
function LastTrip({ trip }: { trip: TripBrief }) {
  const when = trip.start_date ? dateRange(trip.start_date, trip.end_date) : trip.days > 0 ? `${trip.days} 天` : '未设置日期'
  return (
    <div className="mt-4 flex items-center gap-3">
      {/* 小封面：有照片用缩略图，没有时是展示字体的城市名 */}
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-image bg-surface-2">
        {trip.cover_url ? (
          <img src={trip.cover_thumb_url || trip.cover_url} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span aria-hidden className="font-display text-[15px] leading-none text-ink-700">
            {(trip.cities[0] ? cityShort(trip.cities[0]) : trip.title).slice(0, 2)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] tracking-[0.06em] text-ink-500">最近一次</p>
        <p className="truncate text-[14px] text-ink-900">{trip.title}</p>
        <p className="caption truncate">
          <span className="font-num">{when}</span>
          {trip.phase !== 'finished' && ` · ${phases[trip.phase]?.label ?? ''}`}
        </p>
      </div>
    </div>
  )
}

/** 「设为默认」：选中是实心胶囊 + 勾（默认空间），再点一次取消 */
function DefaultToggle({ space }: { space: Space }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const on = space.is_default
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={busy}
      title={on ? '点「我们」时直接打开这个空间；再点一次取消默认' : '设为默认后，点「我们」直接打开这个空间'}
      onClick={async () => {
        setBusy(true)
        try {
          await setDefaultSpace(qc, on ? null : space.id)
          toast.success(on ? '已取消默认空间' : `已把「${space.name}」设为默认空间`, {
            description: on ? undefined : '点「我们」会直接打开它',
          })
        } catch (e) {
          toast.error(errorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
      className={selectedClass(on, 'chip', 'relative z-10 h-7 px-2.5 text-[12px]')}
    >
      {on && <Check aria-hidden strokeWidth={2.75} />}
      {on ? '默认空间' : '设为默认'}
    </button>
  )
}

function SpaceCard({ space: s }: { space: Space }) {
  const days = daysSince(s.anniversary)
  return (
    <article className={selectedClass(s.is_default, 'card', 'flex h-full flex-col p-5')}>
      <div className="flex items-center justify-between gap-3">
        <SpaceTypeBadge space={s} />
        <DefaultToggle space={s} />
      </div>
      <h2 className="mt-4 text-[length:var(--text-card)] leading-snug">
        {/* 整张卡片可点：链接的点击区域撑满卡片，「设为默认」浮在上面 */}
        <Link
          to={`/spaces/${s.id}`}
          className="th-option-title rounded-sm after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:outline-offset-4"
        >
          {s.name}
        </Link>
      </h2>
      {s.description && <p className="caption mt-1 line-clamp-2">{s.description}</p>}
      <div className="mt-4 flex min-w-0 items-center gap-3">
        <MemberStack users={s.members} size={30} max={5} ringClass="ring-surface" />
        <span className="min-w-0 truncate text-[13px] text-ink-700">{memberNames(s.members)}</span>
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-3">
        <Fact label="旅程" value={s.trip_count} unit="段" />
        <Fact label="城市" value={s.city_count} unit="座" />
        {days ? <Fact label={anniversaryLabel(s.type)} value={days} unit="天" /> : <Fact label="成员" value={s.member_count} unit="人" />}
      </dl>
      {s.last_trip ? <LastTrip trip={s.last_trip} /> : <p className="caption mt-4">还没有一起的旅程</p>}
      {s.pending_invite_count > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500">
          <Send className="size-3" strokeWidth={1.5} aria-hidden />
          {s.pending_invite_count} 个邀请等待对方回应
        </p>
      )}
    </article>
  )
}

/** 新建空间的入口卡片（虚线） */
function NewSpaceTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full min-h-44 w-full flex-col items-center justify-center gap-2 rounded-card border border-dashed border-ink-300 p-5 text-center text-ink-700 transition-colors hover:border-ink-500 hover:text-ink-900"
    >
      <span className="flex size-10 items-center justify-center rounded-full border border-line">
        <Plus className="size-5" strokeWidth={1.5} />
      </span>
      <span className="text-[15px] text-ink-900">新建空间</span>
      <span className="caption max-w-[16rem]">情侣、闺蜜、朋友、家人，或者自己起个名</span>
    </button>
  )
}

/** 还没有空间：按类型开始 */
function StartGrid({ onPick }: { onPick: (t: SpaceType) => void }) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {SPACE_TYPES.map((t) => {
        const Icon = t.icon
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onPick(t.value)}
            className="th-card flex flex-col items-start gap-2 p-4 text-left transition-colors hover:border-ink-400"
          >
            <span className="flex items-center gap-2 text-[15px] text-ink-900">
              <Icon className="size-4 text-pink-600" strokeWidth={1.5} aria-hidden />
              {t.value === 'custom' ? '自定义空间' : `${t.label}空间`}
            </span>
            <span className="caption">{t.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * 邀请链接 /together?invite=用户名：对方打开后一键邀请链接的主人加入自己的情侣空间（没有时自动创建）；
 * 已经有情侣时可以新建一个别的空间邀请 TA
 */
function LinkedInvite({
  username,
  invitedBy,
  onDone,
  onCreate,
}: {
  username: string
  invitedBy: boolean
  onDone: () => void
  onCreate: () => void
}) {
  const me = useAuth((s) => s.user)!
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <section className="th-card mt-10 flex flex-col gap-4 border-l-2 border-l-pink-500 p-5 md:mt-14 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p className="eyebrow !text-pink-600">Invite · 邀请链接</p>
        <p className="mt-1.5 text-[15px] text-ink-900">@{username} 想和你一起记录走过的地方</p>
        <p className="caption mt-0.5">
          {invitedBy
            ? 'TA 已经邀请你了：接受上面的邀请就好'
            : me.partner
              ? `你已经和 ${me.partner.nickname || me.partner.username} 在一个情侣空间里了；也可以新建一个空间邀请 TA`
              : '点「发送邀请」，TA 在通知里接受后，你们就有了共同的情侣空间'}
        </p>
      </div>
      {!invitedBy && me.partner && (
        <Button variant="outline" icon={<Plus className="size-4" strokeWidth={1.5} />} onClick={onCreate}>
          新建空间邀请 TA
        </Button>
      )}
      {!invitedBy && !me.partner && (
        <Button
          loading={busy}
          icon={<Send className="size-4" strokeWidth={1.5} />}
          onClick={async () => {
            setBusy(true)
            try {
              await api.partner.invite(username)
              toast.success('邀请已发送，等 TA 接受吧')
              refreshSpaces(qc)
              onDone()
            } catch (e) {
              toast.error(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          发送邀请
        </Button>
      )}
    </section>
  )
}

export default function SpacesPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const me = useAuth((s) => s.user)!
  const [params, setParams] = useSearchParams()
  const spacesQ = useSpaces()
  const invitesQ = useSpaceInvites()
  const newParam = params.get('new')
  const [creating, setCreating] = useState<{ type?: SpaceType; invitee?: string } | null>(
    newParam ? { type: isSpaceType(newParam) ? newParam : undefined } : null,
  )
  const [cancelling, setCancelling] = useState<number | null>(null)
  useDocumentTitle('我们')

  const spaces = spacesQ.data ?? []
  const incoming = invitesQ.data?.incoming ?? []
  const outgoing = invitesQ.data?.outgoing ?? []
  const linkedRaw = (params.get('invite') ?? '').replace(/^@/, '')
  const linked = /^[A-Za-z0-9_]{3,20}$/.test(linkedRaw) && linkedRaw.toLowerCase() !== me.username.toLowerCase() ? linkedRaw : ''
  const dropParam = (k: string) => {
    if (!params.has(k)) return
    const next = new URLSearchParams(params)
    next.delete(k)
    setParams(next, { replace: true })
  }
  const openCreate = (type?: SpaceType) => setCreating({ type })

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 md:px-8 md:pt-16 md:pb-32">
      <header className="animate-slide-up">
        <LabelRow
          label="Together · 我们"
          count={spaces.length ? `${spaces.length} 个空间` : undefined}
          extra={
            <Button size="sm" variant="outline" icon={<Plus className="size-3.5" strokeWidth={1.75} />} onClick={() => openCreate()}>
              新建空间
            </Button>
          }
        />
        <div className="mt-8 grid gap-x-8 gap-y-4 md:mt-12 lg:grid-cols-12 lg:items-end">
          <h1 className="text-display-lg lg:col-span-6">我们</h1>
          <p className="max-w-xl text-[14.5px] leading-[1.8] text-pretty text-ink-500 lg:col-span-6 lg:pb-1.5">
            和不同的人，各有一个空间：情侣、闺蜜、家人、老朋友……一起规划、一起打卡，把走过的地方记在同一张地图上。
          </p>
        </div>
      </header>

      {linked && (
        <LinkedInvite
          username={linked}
          invitedBy={incoming.some((i) => i.inviter.username.toLowerCase() === linked.toLowerCase())}
          onDone={() => dropParam('invite')}
          onCreate={() => setCreating({ type: 'friends', invitee: linked })}
        />
      )}

      {incoming.length > 0 && (
        <section className="mt-12 md:mt-16" aria-labelledby="incoming-title">
          <LabelRow id="incoming-title" label="Invitations · 待回应的邀请" count={incoming.length} />
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {incoming.map((inv) => (
              <IncomingInviteCard
                key={inv.id}
                invite={inv}
                onDone={(accepted, d) => {
                  refreshSpaces(qc, { trips: accepted })
                  if (accepted && d) nav(`/spaces/${d.id}`)
                }}
              />
            ))}
          </div>
        </section>
      )}

      <section className="mt-12 md:mt-16" aria-labelledby="spaces-title">
        <LabelRow
          id="spaces-title"
          label="Spaces · 我的空间"
          extra={spaces.length > 1 && <span className="caption">设为默认后，点「我们」直接打开它</span>}
        />
        {spacesQ.isLoading ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="加载中">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-72 animate-pulse rounded-card bg-surface" />
            ))}
          </div>
        ) : spacesQ.isLoadingError ? (
          <LoadError className="py-10" error={spacesQ.error} onRetry={() => spacesQ.refetch()} />
        ) : spaces.length === 0 ? (
          <div className="mt-6">
            <p className="text-display-md text-ink-900">还没有空间</p>
            <p className="caption mt-2 max-w-xl text-[14px] leading-relaxed">
              建一个空间，邀请 TA 们加入：一起的旅程会汇成共同的足迹地图，还能 3D 回放走过的每一段路。选一种开始吧：
            </p>
            <StartGrid onPick={openCreate} />
          </div>
        ) : (
          <ul className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {spaces.map((s) => (
              <li key={s.id}>
                <SpaceCard space={s} />
              </li>
            ))}
            <li>
              <NewSpaceTile onClick={() => openCreate()} />
            </li>
          </ul>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="mt-12 md:mt-16" aria-labelledby="outgoing-title">
          <LabelRow id="outgoing-title" label="Sent · 已发出的邀请" count={outgoing.length} />
          <ul className="divide-y divide-line border-b border-line">
            {outgoing.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 py-3.5">
                <Avatar user={inv.invitee} size={36} />
                <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink-500">
                  已邀请 <span className="text-ink-900">{inv.invitee.nickname || inv.invitee.username}</span> 加入
                  <Link to={`/spaces/${inv.space.id}`} className="mx-0.5 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
                    「{inv.space.name}」
                  </Link>
                  <span className="caption block">{fromNow(inv.created_at)} · 等待对方回应</span>
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={cancelling === inv.id}
                  disabled={cancelling != null}
                  onClick={async () => {
                    setCancelling(inv.id)
                    try {
                      await api.spaces.cancelInvite(inv.id)
                      toast.success('已撤回邀请')
                    } catch (e) {
                      toast.error(errorMessage(e))
                    } finally {
                      setCancelling(null)
                      refreshSpaces(qc)
                    }
                  }}
                >
                  撤回
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <CreateSpaceDialog
        open={!!creating}
        initialType={creating?.type}
        invitee={creating?.invitee}
        onClose={() => {
          setCreating(null)
          dropParam('new')
        }}
      />
    </div>
  )
}
