import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarHeart, Copy, Crown, LogOut, Plus, Send, Settings2, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Phase, type SpaceDetail, type SpaceMember, type SpaceType } from '@/api'
import { LabelRow } from '@/components/editorial'
import {
  MemberStack,
  SpaceTypeBadge,
  SpaceTypeChooser,
  anniversaryLabel,
  daysSince,
  memberNames,
  refreshSpaces,
  setDefaultSpace,
  useSpaces,
} from '@/components/space'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import {
  Avatar,
  Button,
  CheckBadge,
  Empty,
  Field,
  Input,
  LoadError,
  Modal,
  PageLoader,
  Switch,
  buttonClass,
  confirmDialog,
  selectedClass,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useSite } from '@/hooks/useSite'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import { beijingToday, dayjs, fmtDate, fromNow } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { flattenPages } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

// 共同足迹地图（maplibre + deck.gl）按需加载：空间信息先出来，地图代码与足迹数据同时下载
const loadFootprintsView = () => import('@/components/three/FootprintsView')
const FootprintsView = lazy(() => loadFootprintsView().then((m) => ({ default: m.FootprintsView })))

const phaseFilters: { value: Phase | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'planning', label: '规划中' },
  { value: 'ongoing', label: '旅行中' },
  { value: 'finished', label: '已完成' },
]

const nameOf = (u: { nickname: string; username: string }) => u.nickname || u.username

/** 两个人的情侣空间：两个头像中间一个胭脂色的「&」 */
function CoupleFaces({ members }: { members: SpaceMember[] }) {
  return (
    <div className="flex items-center">
      <Avatar user={members[0]} size={44} ring />
      <span className="font-display z-10 -mx-1 flex size-7 items-center justify-center rounded-full bg-paper text-lg text-pink-600 italic ring-1 ring-line">
        &amp;
      </span>
      <Avatar user={members[1]} size={44} ring />
    </div>
  )
}

/** 统计：小标签 + 主题的大数字档（text-num）+ 单位，格子之间细线 */
function Stats({ s }: { s: SpaceDetail }) {
  const km = formatKm(s.stats.distance_km)
  const [kmValue, kmUnit] = km.includes(' ') ? km.split(' ') : [km, '']
  const items: { label: string; value: ReactNode; unit: string }[] = [
    { label: '旅程', value: s.stats.trip_count, unit: '段' },
    { label: '城市', value: s.stats.cities, unit: '座' },
    { label: '省份', value: s.stats.provinces, unit: '个' },
    { label: '里程', value: kmValue, unit: kmUnit },
    { label: '在路上', value: s.stats.days, unit: '天' },
    { label: '照片', value: s.stats.photos, unit: '张' },
  ]
  return (
    <dl className="grid grid-cols-3 border-t border-line lg:grid-cols-6">
      {items.map((it, k) => (
        <div
          key={it.label}
          className={cn(
            'min-w-0 pt-3 pr-2 pb-5 md:pb-6',
            k % 3 !== 0 && 'border-l border-line pl-3 md:pl-5',
            k >= 3 && 'border-t border-line lg:border-t-0',
            k === 3 && 'lg:border-l lg:pl-5',
          )}
        >
          <dt className="text-xs tracking-[0.06em] text-ink-500">{it.label}</dt>
          <dd className="mt-3 flex items-baseline gap-1">
            <span className="font-num text-num whitespace-nowrap text-ink-900">{it.value}</span>
            <span className="text-xs text-ink-500">{it.unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* ---------------- 邀请 ---------------- */

/** 为什么现在不能邀请 */
function inviteBlocked(s: SpaceDetail): string | null {
  if (s.can_invite) return null
  if (s.type === 'couple') {
    if (s.member_count >= 2) return '情侣空间只能有两个人'
    if (s.role !== 'owner') return '情侣空间只有创建者可以邀请'
    if (s.invites.length) return `已邀请了 ${nameOf(s.invites[0].invitee)}，等待 TA 回应；想换一个人，先撤回那条邀请`
  }
  return '空间最多 50 人（含待接受的邀请）'
}

function InviteForm({ s, autoFocus, onSent }: { s: SpaceDetail; autoFocus?: boolean; onSent: () => void }) {
  const me = useAuth((st) => st.user)!
  const { data: site } = useSite()
  const [username, setUsername] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const blocked = inviteBlocked(s)
  const couple = s.type === 'couple'
  // 情侣空间还只有自己：也可以把邀请链接发给 TA（TA 打开后一键邀请你，你在通知里接受）
  const inviteUrl = `${window.location.origin}/together?invite=${encodeURIComponent(me.username)}`
  const copyInvite = async () => {
    const text = `我在 ${site?.name || 'TripHub'} 等你一起记录我们走过的地方，打开链接注册或登录后点「发送邀请」：${inviteUrl}`
    if (await copyText(text)) toast.success('已复制，发给 TA 吧')
    else toast.error('复制失败，请手动复制')
  }
  if (blocked) return <p className="text-[13.5px] leading-relaxed text-ink-500">{blocked}</p>
  return (
    <div className="space-y-4">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault()
          const u = username.trim().replace(/^@/, '')
          if (!u) return
          setBusy(true)
          try {
            const inv = await api.spaces.invite(s.id, { username: u, message: message.trim() || undefined })
            toast.success(`已邀请 ${nameOf(inv.invitee)}`, { description: '对方接受后就会加入' })
            setUsername('')
            setMessage('')
            onSent()
          } catch (err) {
            // 只在发送成功后清空：用户名打错时改一下就能重发
            toast.error(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label={couple ? 'TA 的用户名' : '对方的用户名'}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={couple ? '输入 TA 的用户名' : '输入用户名，一次邀请一位'}
            autoFocus={autoFocus}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>
        <Field label="想说的话（可选）">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={200}
            placeholder={couple ? '以后的旅行，都一起记录吧' : '一起把去过的地方记在同一张地图上吧'}
          />
        </Field>
        <Button
          type="submit"
          block
          variant={username.trim() ? 'primary' : 'outline'}
          loading={busy}
          disabled={!username.trim() || busy}
          icon={<Send className="size-4" strokeWidth={1.5} />}
        >
          发送邀请
        </Button>
      </form>
      {couple && s.member_count === 1 && (
        <div className="border-t border-line pt-4">
          <p className="text-[13.5px] text-ink-900">或者把邀请链接发给 TA</p>
          <p className="caption mt-0.5">TA 打开链接、注册或登录后点「发送邀请」，你在通知里接受就绑定啦</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} aria-label="邀请链接" className="text-[13px]" />
            <Button variant="outline" icon={<Copy className="size-4" strokeWidth={1.5} />} onClick={copyInvite}>
              复制链接
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- 设置（右侧抽屉，手机上是底部面板） ---------------- */

function EditSpaceForm({ s, onSaved }: { s: SpaceDetail; onSaved: (d: SpaceDetail) => void }) {
  const spaces = useSpaces()
  const [name, setName] = useState(s.name)
  const [type, setType] = useState<SpaceType>(s.type)
  const [label, setLabel] = useState(s.type === 'custom' ? s.type_label : '')
  const [desc, setDesc] = useState(s.description)
  const [anniv, setAnniv] = useState(s.anniversary ?? '')
  const [pub, setPub] = useState(s.public)
  const [saving, setSaving] = useState(false)
  const today = beijingToday()
  const otherCouple = spaces.data?.find((x) => x.type === 'couple' && x.id !== s.id)
  const people = s.member_count + s.invites.length
  const coupleBlocked = otherCouple ? `你已在情侣空间「${otherCouple.name}」中` : people > 2 ? '情侣空间最多两个人（含待接受的邀请）' : undefined
  const save = async () => {
    if (!name.trim()) return toast.error('空间名称不能为空')
    if (type === 'custom' && !label.trim()) return toast.error('给自定义的类型起个名字吧')
    if (anniv && anniv > today) return toast.error('纪念日不能晚于今天')
    setSaving(true)
    try {
      const d = await api.spaces.update(s.id, {
        name: name.trim(),
        type,
        type_label: type === 'custom' ? label.trim() : undefined,
        description: desc.trim(),
        anniversary: anniv || null,
        public: type === 'couple' ? pub : undefined,
      })
      toast.success('已保存')
      onSaved(d)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-5">
      <Field label="空间名称">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} className="font-display text-[16px]" />
      </Field>
      <div>
        <span className="mb-2 block text-[12.5px] font-medium text-ink-600">类型</span>
        <SpaceTypeChooser value={type} onChange={setType} disabled={type !== 'couple' && coupleBlocked ? { couple: coupleBlocked } : undefined} />
        {type !== 'couple' && coupleBlocked && <p className="mt-2 text-xs text-ink-500">改成情侣空间：{coupleBlocked}</p>}
      </div>
      {type === 'custom' && (
        <Field label="类型名称" hint="最多 10 个字">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={10} placeholder="如：驴友团、室友、球队" />
        </Field>
      )}
      <Field label="一句话介绍">
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={120} placeholder="可以不写" />
      </Field>
      <Field label={type === 'couple' ? '在一起的纪念日' : '纪念日（可选）'} hint={type === 'couple' ? '用来计算「在一起 N 天」' : '如第一次一起旅行的日子'}>
        <div className="flex gap-2">
          <Input type="date" value={anniv} max={today} onChange={(e) => setAnniv(e.target.value)} className="font-num" />
          {anniv && (
            <Button variant="ghost" onClick={() => setAnniv('')}>
              清除
            </Button>
          )}
        </div>
      </Field>
      {type === 'couple' && (
        <div className="space-y-1">
          <Switch checked={pub} onChange={setPub} label="在个人主页公开情侣关系" />
          <p className="pl-12 text-xs leading-relaxed text-ink-500">开启后，你们的个人主页会显示对方；关闭时只有你们自己能看到（两人共享这个设置）</p>
        </div>
      )}
      <Button loading={saving} onClick={save}>
        保存修改
      </Button>
    </div>
  )
}

function SectionTitle({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <p className="flex items-baseline gap-3 border-t border-line pt-4 pb-3">
      <span className="eyebrow !text-ink-900">{children}</span>
      {count != null && <span className="font-num text-[13px] text-ink-500">{count}</span>}
    </p>
  )
}

type SettingsFocus = 'members' | 'invite' | 'about'

function SpaceSettings({
  s,
  focus,
  onClose,
}: {
  s: SpaceDetail
  focus: SettingsFocus
  onClose: () => void
}) {
  const me = useAuth((st) => st.user)!
  const qc = useQueryClient()
  const nav = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  // 从「设置纪念日」进来：滚到空间信息
  const aboutRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focus === 'about') requestAnimationFrame(() => aboutRef.current?.scrollIntoView({ block: 'start' }))
  }, [focus])
  const couple = s.type === 'couple'
  const owner = s.role === 'owner'
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['space', s.id] })
    refreshSpaces(qc)
  }
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key)
    try {
      await fn()
      toast.success(ok)
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(null)
    }
  }
  const leave = async () => {
    const others = s.members.filter((m) => m.id !== me.id)
    const desc =
      others.length === 0
        ? '你是最后一位成员，退出后空间会被删除；旅程都会保留，只是不再属于这个空间。'
        : owner
          ? `你是创建者：退出后 ${nameOf(others[0])} 将成为新的创建者。你创建的旅程会随你离开空间（仍然属于你），你将看不到其他人的旅程（你是共同作者的除外）。`
          : '退出后你将看不到空间里其他人的旅程（你是共同作者的除外）；你创建的旅程会随你离开空间，仍然属于你。'
    if (!(await confirmDialog({ title: `退出「${s.name}」？`, desc, okText: '退出空间', danger: true }))) return
    if (await run('leave', () => api.spaces.removeMember(s.id, me.id), `已退出「${s.name}」`)) {
      onClose()
      await nav('/spaces', { replace: true })
      qc.removeQueries({ queryKey: ['space', s.id] })
      refreshSpaces(qc, { trips: true })
    }
  }
  const removeMember = async (m: SpaceMember) => {
    const ok = await confirmDialog({
      title: `把 ${nameOf(m)} 移出「${s.name}」？`,
      desc: 'TA 将看不到空间里其他人的旅程（是共同作者的除外），TA 创建的旅程会随 TA 离开空间。TA 会收到通知。',
      okText: '移出',
      danger: true,
    })
    if (!ok) return
    if (await run(`remove-${m.id}`, () => api.spaces.removeMember(s.id, m.id), `已移出 ${nameOf(m)}`)) {
      refresh()
      void qc.invalidateQueries({ queryKey: ['space-trips', s.id] })
      void qc.invalidateQueries({ queryKey: ['space-footprints', s.id] })
    }
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: `删除「${s.name}」？`,
      desc: '空间里的旅程都会保留，只是不再属于这个空间；其他成员会收到通知。这一步不能撤销。',
      okText: '删除空间',
      danger: true,
    })
    if (!ok) return
    if (await run('delete', () => api.spaces.remove(s.id), `已删除「${s.name}」`)) {
      onClose()
      await nav('/spaces', { replace: true })
      qc.removeQueries({ queryKey: ['space', s.id] })
      refreshSpaces(qc, { trips: true })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="空间设置"
      // 宽屏是贴在右侧的整高抽屉；手机上是底部面板
      className="sm:mr-0 sm:ml-auto sm:h-full sm:max-h-none sm:max-w-md"
    >
      <div className="space-y-8 pb-2">
        <section>
          <SectionTitle count={`${s.member_count} 人`}>Members · 成员</SectionTitle>
          <ul className="divide-y divide-line">
            {s.members.map((m) => {
              const self = m.id === me.id
              return (
                <li key={m.id} className="flex items-center gap-3 py-3">
                  <Avatar user={m} size={38} />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5 text-[14.5px] text-ink-900">
                      <Link to={`/u/${m.username}`} className="truncate hover:underline" onClick={onClose}>
                        {nameOf(m)}
                      </Link>
                      {self && <span className="shrink-0 text-xs text-ink-500">（你）</span>}
                    </p>
                    <p className="caption flex items-center gap-1">
                      {m.space_role === 'owner' && <Crown className="size-3 text-amber-600" strokeWidth={1.75} aria-hidden />}
                      {m.space_role === 'owner' ? '创建者' : '成员'} · {fmtDate(m.joined_at)} 加入
                    </p>
                  </div>
                  {self ? (
                    <Button size="sm" variant="outline" loading={busy === 'leave'} disabled={!!busy} onClick={leave}>
                      退出
                    </Button>
                  ) : (
                    owner && (
                      <Button size="sm" variant="ghost" loading={busy === `remove-${m.id}`} disabled={!!busy} onClick={() => removeMember(m)}>
                        移出
                      </Button>
                    )
                  )}
                </li>
              )
            })}
            {s.invites.map((inv) => {
              const canCancel = owner || inv.inviter.id === me.id
              return (
                <li key={`inv-${inv.id}`} className="flex items-center gap-3 py-3">
                  <Avatar user={inv.invitee} size={38} className="opacity-70" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] text-ink-700">{nameOf(inv.invitee)}</p>
                    <p className="caption truncate">
                      已邀请，等待回应 · {fromNow(inv.created_at)}
                      {inv.inviter.id !== me.id && ` · ${nameOf(inv.inviter)} 邀请`}
                    </p>
                  </div>
                  {canCancel && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `cancel-${inv.id}`}
                      disabled={!!busy}
                      onClick={async () => {
                        await run(`cancel-${inv.id}`, () => api.spaces.cancelInvite(inv.id), '已撤回邀请')
                        refresh()
                      }}
                    >
                      撤回
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <section>
          <SectionTitle>Invite · 邀请{couple ? ' TA' : '成员'}</SectionTitle>
          <InviteForm s={s} autoFocus={focus === 'invite'} onSent={refresh} />
        </section>

        <section>
          <SectionTitle>Default · 默认空间</SectionTitle>
          <button
            type="button"
            aria-pressed={s.is_default}
            disabled={busy === 'default'}
            onClick={async () => {
              setBusy('default')
              try {
                await setDefaultSpace(qc, s.is_default ? null : s.id)
                toast.success(s.is_default ? '已取消默认空间' : '已设为默认空间', { description: s.is_default ? undefined : '点「我们」会直接打开这里' })
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(null)
              }
            }}
            className={selectedClass(s.is_default, 'card', 'flex w-full items-center gap-3 px-4 py-3.5 text-left')}
          >
            <span className="min-w-0 flex-1">
              <span className="th-option-title text-[15px]">{s.is_default ? '这是你的默认空间' : '设为默认空间'}</span>
              <span className="caption mt-0.5 block">{s.is_default ? '点「我们」时直接打开这里；再点一次取消' : '点「我们」时直接打开这里'}</span>
            </span>
            <CheckBadge />
          </button>
        </section>

        <section ref={aboutRef}>
          <SectionTitle>About · 空间信息</SectionTitle>
          {s.can_manage ? (
            <EditSpaceForm
              s={s}
              onSaved={(d) => {
                qc.setQueryData(['space', s.id], d)
                refreshSpaces(qc)
              }}
            />
          ) : (
            <p className="text-[13.5px] leading-relaxed text-ink-500">只有创建者 {nameOf(s.owner)} 可以修改空间的名称、类型和纪念日。</p>
          )}
        </section>

        <section>
          <SectionTitle>Leave · 退出与删除</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={<LogOut className="size-4" strokeWidth={1.5} />} loading={busy === 'leave'} disabled={!!busy} onClick={leave}>
              退出空间
            </Button>
            {owner && (
              <Button variant="danger" icon={<Trash2 className="size-4" strokeWidth={1.5} />} loading={busy === 'delete'} disabled={!!busy} onClick={remove}>
                删除空间
              </Button>
            )}
          </div>
          <p className="caption mt-3 leading-relaxed">
            {owner ? '删除空间不会删除任何旅程。' : ''}退出后，你创建的旅程会随你离开空间，仍然属于你。
          </p>
        </section>
      </div>
    </Modal>
  )
}

/* ---------------- 页面 ---------------- */

export default function SpacePage() {
  const { id } = useParams()
  const sid = Number(id)
  const me = useAuth((st) => st.user)!
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['space', sid], queryFn: () => api.spaces.get(sid), enabled: Number.isInteger(sid) && sid > 0 })
  const s = q.data
  const fpQ = useQuery({ queryKey: ['space-footprints', sid], queryFn: () => api.spaces.footprints(sid), enabled: !!s })
  const [phase, setPhase] = useState<Phase | ''>('')
  const tripsQ = useInfiniteQuery({
    queryKey: ['space-trips', sid, phase],
    queryFn: ({ pageParam }) => api.spaces.trips(sid, { phase, page: pageParam, page_size: 12 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: !!s,
  })
  const [settings, setSettings] = useState<SettingsFocus | null>(null)
  useDocumentTitle(s?.name ?? '我们')
  useEffect(() => {
    if (s) void loadFootprintsView()
  }, [s])
  // 默认空间已不存在（被移出、空间被删除）：本地保存的 Me 过期了，刷新后「我们」会打开总览
  const gone = isNotFound(q.error)
  useEffect(() => {
    if (gone) void useAuth.getState().refreshMe()
  }, [gone])

  if (!Number.isInteger(sid) || sid <= 0) return <Empty className="min-h-[60vh]" title="页面不存在" />
  if (q.isLoading) return <PageLoader />
  if (!s)
    return (
      <LoadError
        className="min-h-[60vh]"
        error={q.error}
        onRetry={() => q.refetch()}
        notFoundTitle="空间不存在，或你已不在其中"
        desc={gone ? '可能已被删除，或你已退出 / 被移出这个空间' : undefined}
        back={
          <Link to="/spaces" className={buttonClass({ variant: 'outline' })}>
            查看我的空间
          </Link>
        }
      />
    )

  const couple = s.type === 'couple'
  const days = daysSince(s.anniversary)
  const alone = s.member_count === 1
  const trips = flattenPages(tripsQ.data?.pages)
  const total = tripsQ.data?.pages[0]?.total
  const others = s.members.filter((m) => m.id !== me.id)
  const newTrip = `/trips/new?space=${s.id}`

  const counter =
    days != null ? (
      <div className="border-t border-line pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
        <p className="flex items-baseline justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] text-ink-900">
            <span className="size-1.5 rounded-full bg-pink-500" aria-hidden />
            {anniversaryLabel(s.type)}
          </span>
          <span className="eyebrow">{couple ? 'Days together' : 'Since'}</span>
        </p>
        <p className="mt-4 flex items-baseline gap-2">
          <span className="font-num text-num text-ink-900">{days.toLocaleString()}</span>
          <span className="text-xs text-ink-500">天</span>
        </p>
        <p className="caption font-num mt-2">since {dayjs(s.anniversary).format('YYYY.MM.DD')}</p>
      </div>
    ) : couple && s.can_manage ? (
      <button
        type="button"
        onClick={() => setSettings('about')}
        className="inline-flex h-10 items-center gap-2 text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
      >
        <CalendarHeart className="size-4 text-pink-600" strokeWidth={1.4} />
        设置在一起的纪念日
      </button>
    ) : s.stats.first_date ? (
      <div className="border-t border-line pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
        <p className="text-[13px] text-ink-900">第一次一起出发</p>
        <p className="font-num mt-2 text-[22px] leading-none text-ink-900">{dayjs(s.stats.first_date).format('YYYY.MM.DD')}</p>
      </div>
    ) : null

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-8 pb-24 md:px-8 md:pt-14 md:pb-32">
      <header className="animate-slide-up">
        <LabelRow
          label={
            <Link to="/spaces" className="transition-colors hover:text-ink-500">
              Together · 我们
            </Link>
          }
          count={others.length ? memberNames(s.members) : undefined}
          extra={
            <div className="-mr-2 flex items-center gap-1">
              {s.can_invite && (
                <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" strokeWidth={1.5} />} onClick={() => setSettings('invite')}>
                  邀请
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<Settings2 className="size-3.5" strokeWidth={1.5} />} onClick={() => setSettings('members')}>
                设置
              </Button>
            </div>
          }
        />
        <div className="mt-8 grid gap-x-8 gap-y-8 md:mt-12 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-8">
            <div className="flex items-center gap-3">
              {couple && s.members.length === 2 ? <CoupleFaces members={s.members} /> : <MemberStack users={s.members} size={44} max={7} />}
              {s.can_invite && (
                <button
                  type="button"
                  onClick={() => setSettings('invite')}
                  aria-label="邀请成员"
                  title="邀请成员"
                  className="flex size-11 items-center justify-center rounded-full border border-dashed border-ink-300 text-ink-600 transition-colors hover:border-ink-600 hover:text-ink-900"
                >
                  <UserPlus className="size-4" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <SpaceTypeBadge space={s} />
              {s.is_default && (
                <span className="inline-flex h-6 items-center rounded-full bg-brand-50 px-2 text-[12px] leading-none text-brand-700">默认空间</span>
              )}
              {s.invites.length > 0 && (
                <span className="caption">
                  等待 {s.invites.slice(0, 2).map((i) => nameOf(i.invitee)).join('、')}
                  {s.invites.length > 2 ? ` 等 ${s.invites.length} 人` : ''} 加入
                </span>
              )}
            </div>
            <h1 className="text-display-lg mt-3 text-balance break-words">{s.name}</h1>
            {s.description && <p className="mt-3 max-w-2xl text-[14.5px] leading-[1.8] text-ink-500">{s.description}</p>}
          </div>
          {counter && <div className="lg:col-span-4 lg:pb-1">{counter}</div>}
        </div>
      </header>

      {alone && (
        <section className="th-card mt-10 grid gap-6 p-5 md:mt-14 md:p-6 lg:grid-cols-12 lg:gap-8" aria-labelledby="invite-title">
          <div className="lg:col-span-5">
            <p className="eyebrow">Invite · 邀请</p>
            <h2 id="invite-title" className="text-display-md mt-2">
              {couple ? '邀请 TA 加入' : '邀请大家加入'}
            </h2>
            <p className="caption mt-2 max-w-md leading-relaxed">
              {s.invites.length
                ? `已邀请 ${s.invites.map((i) => nameOf(i.invitee)).join('、')}，等待对方回应。`
                : '空间里现在只有你。'}
              对方接受邀请后，你们一起的旅程会汇成共同的足迹地图，还能 3D 回放走过的每一段路。
            </p>
          </div>
          <div className="lg:col-span-6 lg:col-start-7">
            <InviteForm
              s={s}
              onSent={() => {
                void qc.invalidateQueries({ queryKey: ['space', s.id] })
                refreshSpaces(qc)
              }}
            />
          </div>
        </section>
      )}

      <section className="mt-12 md:mt-16" aria-label="统计">
        <Stats s={s} />
      </section>

      <section className="mt-8 md:mt-12" aria-label="共同足迹">
        {fpQ.isLoading ? (
          <div className="h-[62vh] min-h-80 animate-pulse bg-surface" />
        ) : fpQ.isLoadingError ? (
          <LoadError className="py-8" title="足迹加载失败" error={fpQ.error} onRetry={() => fpQ.refetch()} />
        ) : fpQ.data && fpQ.data.stats.waypoints === 0 ? (
          <div className="border-t border-line">
            <Empty
              className="py-14"
              title="还没有一起的足迹"
              desc={`新建旅程时在「和谁一起」里选「${s.name}」，打卡后足迹就会出现在这里`}
              action={
                <Link to={newTrip} className={buttonClass({ variant: 'outline' })}>
                  <Plus className="size-4" strokeWidth={1.5} />
                  规划一次一起的旅行
                </Link>
              }
            />
          </div>
        ) : (
          fpQ.data && (
            <Suspense fallback={<div className="h-[68svh] min-h-[26rem] animate-pulse border-t border-line bg-surface md:h-[76vh]" />}>
              <FootprintsView
                data={fpQ.data}
                theme={couple ? 'love' : 'sunset'}
                replayTo={`/spaces/${s.id}/replay`}
                label="Atlas · 共同足迹"
                bleed
                height="h-[68svh] min-h-[26rem] md:h-[76vh] md:min-h-[34rem]"
              />
            </Suspense>
          )
        )}
      </section>

      <section className="mt-16 md:mt-24" aria-labelledby="trips-title">
        <LabelRow
          id="trips-title"
          label="Trips · 一起的旅程"
          count={total != null && !phase ? `${total} 段` : undefined}
          extra={
            <Link to={newTrip} className={buttonClass({ size: 'sm', variant: 'outline' })}>
              <Plus className="size-3.5" strokeWidth={1.75} />
              新旅程
            </Link>
          }
        />
        <div role="group" aria-label="按阶段筛选" className="mt-3 -ml-1 flex flex-wrap items-center gap-1">
          {phaseFilters.map((f) => (
            <button
              key={f.value || 'all'}
              type="button"
              aria-pressed={phase === f.value}
              onClick={() => setPhase(f.value)}
              className={selectedClass(phase === f.value, 'filter', 'inline-flex h-9 items-center px-3 text-[13.5px]')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="mt-8 md:mt-10">
          {tripsQ.isLoading ? (
            <TripGridSkeleton n={4} />
          ) : tripsQ.isLoadingError ? (
            <LoadError className="py-8" error={tripsQ.error} onRetry={() => tripsQ.refetch()} />
          ) : trips.length ? (
            <>
              <TripGrid trips={trips} showAuthor={!alone} />
              {tripsQ.hasNextPage && (
                <div className="mt-12 flex justify-center">
                  <Button variant="outline" loading={tripsQ.isFetchingNextPage} onClick={() => tripsQ.fetchNextPage()}>
                    加载更多
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="caption">
              {phase ? '没有这个阶段的旅程' : '还没有一起的旅程：新建旅程时在「和谁一起」里选这个空间，或在旅程页把已有的旅程加入进来。'}
            </p>
          )}
        </div>
      </section>

      {settings && <SpaceSettings s={s} focus={settings} onClose={() => setSettings(null)} />}
    </div>
  )
}
