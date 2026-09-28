import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarHeart, Copy, Heart, HeartCrack, PenLine, Plus, Send, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type PartnerInfo } from '@/api'
import { FootprintStats } from '@/components/three/FootprintStats'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import {
  Avatar,
  Button,
  Empty,
  Field,
  Input,
  LoadError,
  Menu,
  MenuItem,
  Modal,
  PageLoader,
  Switch,
  UserName,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { copyText } from '@/lib/clipboard'
import { dayjs, fromNow, beijingToday } from '@/lib/format'
import { flattenPages } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

// 共同足迹地图（maplibre + deck.gl）只在绑定情侣空间后显示：按需加载，还没绑定时只看到邀请表单
const loadFootprintsView = () => import('@/components/three/FootprintsView')
const FootprintsView = lazy(() => loadFootprintsView().then((m) => ({ default: m.FootprintsView })))

/** 细线标签行：一条 border-t，左侧小标签 + 灰色计数，右侧操作 */
function LabelRow({ label, count, extra }: { label: string; count?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1">
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && <span className="text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

/** 两个相交的细线圆 + 胭脂色的「&」：情侣空间的标记 */
function UnionMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 140 90" className={className} fill="none" stroke="currentColor" aria-hidden>
      <circle cx={45} cy={45} r={43} strokeWidth={0.8} />
      <circle cx={95} cy={45} r={43} strokeWidth={0.8} />
      <text x={70} y={56} textAnchor="middle" fill="var(--color-pink-600)" stroke="none" fontFamily="var(--font-display)" fontStyle="italic" fontWeight={300} fontSize={30}>
        &amp;
      </text>
    </svg>
  )
}

function Invites({ info, refresh }: { info: PartnerInfo; refresh: () => void }) {
  const me = useAuth((s) => s.user)!
  const refreshMe = useAuth((s) => s.refreshMe)
  const { data: site } = useSite()
  // 邀请链接 /together?invite=用户名：对方打开（没登录时先注册 / 登录，再回到这里）后预填邀请人，点一下就能发出邀请
  const [params, setParams] = useSearchParams()
  const fromLink = (params.get('invite') ?? '').replace(/^@/, '')
  const linked = /^[A-Za-z0-9_]{3,20}$/.test(fromLink) && fromLink.toLowerCase() !== me.username.toLowerCase() ? fromLink : ''
  // 对方已经发来邀请时直接接受即可，不用再发
  const linkedInvited = !!linked && info.invites.incoming.some((inv) => inv.from.username.toLowerCase() === linked.toLowerCase())
  const [username, setUsername] = useState(linkedInvited ? '' : linked)
  const [message, setMessage] = useState('')
  // 进行中的操作（如 accept-3）：请求期间禁用所有按钮，连点不会重复提交
  const [busy, setBusy] = useState<string | null>(null)
  const inviteUrl = `${window.location.origin}/together?invite=${encodeURIComponent(me.username)}`
  const act = async (key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(key)
    try {
      await fn()
      toast.success(ok)
      refreshMe()
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    } finally {
      setBusy(null)
      // 失败也刷新：邀请可能已被撤回 / 处理，或者对方已经向你发出了邀请
      refresh()
    }
  }
  const copyInvite = async () => {
    const text = `我在 ${site?.name || 'TripHub'} 等你一起记录「我们一起走过的地方」，打开链接注册或登录后点「发送邀请」：${inviteUrl}`
    if (await copyText(text)) toast.success('已复制，发给 TA 吧')
    else toast.error('复制失败，请手动复制')
  }
  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 md:px-8 md:pt-16 md:pb-36">
      <header className="animate-slide-up">
        <LabelRow label="Together · 我们" count="情侣空间" />
      </header>
      <div className="mt-12 grid gap-x-8 gap-y-16 md:mt-20 lg:grid-cols-12">
        <div className="animate-slide-up lg:col-span-6 [animation-delay:80ms] [animation-fill-mode:backwards]">
          <UnionMark className="w-28 text-ink-400 md:w-36" />
          <h1 className="text-display-xl mt-10 font-normal md:mt-14">我们一起走过的地方</h1>
          <p className="mt-8 max-w-md text-[15px] leading-[1.8] text-ink-900">和 TA 绑定情侣空间，一起的旅程会汇成共同的足迹地图。</p>
          <p className="caption mt-1 max-w-md leading-[1.8]">点亮你们一起去过的城市，还能 3D 回放你们走过的每一段路。</p>
        </div>

        <div className="animate-slide-up space-y-14 lg:col-span-5 lg:col-start-8 [animation-delay:160ms] [animation-fill-mode:backwards]">
          {info.invites.incoming.length > 0 && (
            <section>
              <LabelRow label="Received · 收到的邀请" count={<span className="font-num">{info.invites.incoming.length}</span>} />
              <ul className="divide-y divide-ink-200">
                {info.invites.incoming.map((inv) => (
                  <li key={inv.id} className="py-5">
                    <div className="flex items-center gap-3">
                      <Avatar user={inv.from} size={44} />
                      <div className="min-w-0 flex-1">
                        <UserName user={inv.from} className="text-[15px] text-ink-900" />
                        <div className="caption">{fromNow(inv.created_at)} 邀请你绑定情侣空间</div>
                      </div>
                    </div>
                    {inv.message && (
                      <p className="font-display mt-4 border-l border-pink-500 py-0.5 pl-4 text-lg leading-relaxed text-ink-800">“{inv.message}”</p>
                    )}
                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        disabled={!!busy}
                        loading={busy === `decline-${inv.id}`}
                        onClick={() => act(`decline-${inv.id}`, () => api.partner.decline(inv.id), '已拒绝')}
                      >
                        婉拒
                      </Button>
                      <Button
                        variant="love"
                        icon={<Heart className="size-4" strokeWidth={1.5} />}
                        disabled={!!busy}
                        loading={busy === `accept-${inv.id}`}
                        onClick={() => act(`accept-${inv.id}`, () => api.partner.accept(inv.id), '绑定成功')}
                      >
                        接受
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {linked && (
            <p className="border-l border-pink-500 py-1 pl-4 text-[13.5px] leading-relaxed text-ink-700">
              <span className="eyebrow mr-2 !text-pink-600">Invite</span>
              {linkedInvited
                ? `@${linked} 已经邀请你了，点上面的「接受」就绑定啦`
                : `@${linked} 邀请你绑定情侣空间，点「发送邀请」，TA 确认后就绑定啦`}
            </p>
          )}

          <section>
            <LabelRow label="Invite · 邀请 TA" />
            <div className="mt-6 space-y-5">
              <Field label="对方的用户名">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入 TA 的用户名，或把下方邀请链接发给 TA" />
              </Field>
              <Field label="想说的话（可选）">
                <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={100} placeholder="以后的旅行，都一起记录吧" />
              </Field>
              <Button
                block
                size="lg"
                variant="love"
                loading={busy === 'send'}
                disabled={!username.trim() || !!busy}
                icon={<Send className="size-4" strokeWidth={1.5} />}
                onClick={async () => {
                  // 只在发送成功后清空：用户名打错（用户不存在）时保留输入，改一下就能重发
                  if (await act('send', () => api.partner.invite(username.trim(), message.trim() || undefined), '邀请已发送，等 TA 接受吧')) {
                    setUsername('')
                    setMessage('')
                    // 邀请链接已用过：去掉地址里的 invite，提示随之消失
                    if (params.has('invite')) {
                      const next = new URLSearchParams(params)
                      next.delete('invite')
                      setParams(next, { replace: true })
                    }
                  }
                }}
              >
                发送邀请
              </Button>
            </div>
          </section>

          <section>
            <LabelRow label="Link · 邀请链接" count={`@${me.username}`} />
            <p className="mt-4 text-[15px] text-ink-900">把邀请链接发给 TA</p>
            <p className="caption mt-0.5">TA 打开链接、注册或登录后点「发送邀请」，你在通知里接受就绑定啦</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} aria-label="邀请链接" className="font-num" />
              <Button variant="outline" icon={<Copy className="size-4" strokeWidth={1.5} />} onClick={copyInvite}>
                复制邀请链接
              </Button>
            </div>
          </section>

          {info.invites.outgoing.length > 0 && (
            <section>
              <LabelRow label="Sent · 已发出" count={<span className="font-num">{info.invites.outgoing.length}</span>} />
              <ul className="divide-y divide-ink-200">
                {info.invites.outgoing.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-3 py-4">
                    <Avatar user={inv.to} size={36} />
                    <div className="min-w-0 flex-1 text-[13.5px] text-ink-500">
                      已邀请 <span className="font-display text-base text-ink-900">{inv.to.nickname || inv.to.username}</span>，等待对方接受
                    </div>
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      loading={busy === `cancel-${inv.id}`}
                      onClick={() => act(`cancel-${inv.id}`, () => api.partner.cancel(inv.id), '已撤回')}
                    >
                      撤回
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// 打开时才挂载：每次都从最新的空间信息开始编辑（公开设置双方共享，对方可能刚改过）
function EditSpace({ info, onClose, onSaved }: { info: PartnerInfo; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(info.title)
  const [since, setSince] = useState(info.since ?? '')
  const [pub, setPub] = useState(info.public)
  const [saving, setSaving] = useState(false)
  const today = beijingToday()
  return (
    <Modal
      open
      onClose={onClose}
      title="编辑我们的空间"
      footer={
        <Button
          variant="love"
          loading={saving}
          onClick={async () => {
            // 日期是 YYYY-MM-DD，可以直接按字符串比较
            if (since && since > today) return toast.error('纪念日不能晚于今天')
            setSaving(true)
            try {
              qc.setQueryData(['partner'], await api.partner.update({ title: title.trim(), since: since || null, public: pub }))
              // 个人主页上显示的情侣（公开设置）随之变化
              qc.invalidateQueries({ queryKey: ['user'] })
              onSaved()
              onClose()
            } catch (e) {
              toast.error(errorMessage(e))
            } finally {
              setSaving(false)
            }
          }}
        >
          保存
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="空间名称">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="我们一起走过的地方" maxLength={30} />
        </Field>
        <Field label="在一起的日子" hint="用来计算「在一起 N 天」">
          <Input type="date" value={since} max={today} onChange={(e) => setSince(e.target.value)} />
        </Field>
        <div className="space-y-1 rounded-lg border border-ink-200 p-3">
          <Switch checked={pub} onChange={setPub} label="在个人主页公开情侣关系" />
          <p className="pl-12 text-xs leading-relaxed text-ink-400">
            开启后，你们的个人主页会显示对方；关闭时只有你们自己能看到（双方共享此设置）
          </p>
        </div>
      </div>
    </Modal>
  )
}

function UnbindDialog({ onClose, onUnbind }: { onClose: () => void; onUnbind: (removeShared: boolean) => Promise<void> }) {
  const [removeShared, setRemoveShared] = useState(false)
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Modal
      open
      onClose={close}
      title="解除情侣空间？"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onUnbind(removeShared)
              } finally {
                setBusy(false)
              }
            }}
          >
            解除绑定
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-500">解除后共同足迹页面将不再显示，一起的旅程不会被删除。</p>
      <div className="mt-4 space-y-1 rounded-lg border border-ink-200 p-3">
        <Switch checked={removeShared} onChange={setRemoveShared} label="同时结束共同作者关系" />
        <p className="pl-12 text-xs leading-relaxed text-ink-400">
          开启后，你们将不再是对方所创建旅程的共同作者（包括待接受的邀请）；不开启时仍可以一起编辑这些旅程，之后也可以在旅程「成员」中移除。
        </p>
      </div>
    </Modal>
  )
}

export default function TogetherPage() {
  const me = useAuth((s) => s.user)!
  const refreshMe = useAuth((s) => s.refreshMe)
  const nav = useNavigate()
  const qc = useQueryClient()
  const infoQ = useQuery({ queryKey: ['partner'], queryFn: api.partner.get })
  const partner = infoQ.data?.partner
  const fpQ = useQuery({ queryKey: ['partner-footprints'], queryFn: api.partner.footprints, enabled: !!partner })
  const tripsQ = useInfiniteQuery({
    queryKey: ['partner-trips'],
    queryFn: ({ pageParam }) => api.partner.trips({ page: pageParam, page_size: 50 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: !!partner,
  })
  const [editing, setEditing] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  useDocumentTitle(infoQ.data?.title || '我们一起走过的地方')
  // 已绑定：地图代码与足迹数据同时下载
  useEffect(() => {
    if (partner) void loadFootprintsView()
  }, [partner])

  // 对方在自己的设备上接受邀请或解除绑定后，本地保存的用户信息（me.partner）会过期：
  // 与服务端不一致时刷新，「新旅程」的「和 TA 一起」、我的页等才会正确
  const serverPartnerId = infoQ.data ? (infoQ.data.partner?.id ?? 0) : null
  const localPartnerId = me.partner?.id ?? 0
  useEffect(() => {
    if (serverPartnerId === null || serverPartnerId === localPartnerId) return
    void refreshMe()
    qc.invalidateQueries({ queryKey: ['partner'] })
  }, [serverPartnerId, localPartnerId, refreshMe, qc])

  if (infoQ.isLoading) return <PageLoader />
  const info = infoQ.data
  if (!info) return <LoadError error={infoQ.error} onRetry={() => infoQ.refetch()} />
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['partner'] })
    qc.invalidateQueries({ queryKey: ['partner-footprints'] })
    // 解除后很快又绑定（可能是另一个人）时不显示缓存里上一段关系的旅程
    qc.invalidateQueries({ queryKey: ['partner-trips'] })
  }

  if (!partner) return <Invites info={info} refresh={refresh} />

  const days = info.since ? dayjs().startOf('day').diff(dayjs(info.since), 'day') + 1 : null
  const sharedTrips = flattenPages(tripsQ.data?.pages)
  const unbind = async (removeShared: boolean) => {
    try {
      await api.partner.unbind(removeShared)
      toast.success('已解除绑定')
      setUnbinding(false)
      refreshMe()
      refresh()
      // 共同作者关系可能已结束：旅程列表、个人主页、足迹里的旅程随之变化
      invalidateTripLists(qc)
      if (removeShared) {
        qc.invalidateQueries({ queryKey: ['trip'] })
        qc.invalidateQueries({ queryKey: ['members'] })
      }
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const meName = me.nickname || me.username
  const partnerName = partner.nickname || partner.username
  const settings = (
    <Menu
      trigger={(t, open) => (
        <button
          type="button"
          onClick={t}
          aria-expanded={open}
          className="-mr-2 inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-500 transition-colors hover:text-ink-900"
        >
          <Settings2 className="size-3.5" strokeWidth={1.4} />
          设置
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem icon={<PenLine className="size-4" />} onClick={() => (close(), setEditing(true))}>
            编辑名称、纪念日和公开设置
          </MenuItem>
          <MenuItem icon={<HeartCrack className="size-4" />} danger onClick={() => (close(), setUnbinding(true))}>
            解除绑定
          </MenuItem>
        </>
      )}
    </Menu>
  )

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 md:px-8 md:pt-16 md:pb-36">
      <header className="animate-slide-up">
        <LabelRow
          label="Together · 我们"
          count={
            <>
              {meName} <span className="font-display text-pink-600 italic">&amp;</span> {partnerName}
            </>
          }
          extra={settings}
        />
        <div className="mt-12 grid gap-x-8 gap-y-12 md:mt-20 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-8">
            <div className="flex items-center">
              <Avatar user={me} size={44} ring />
              <span className="font-display z-10 -mx-1 flex size-7 items-center justify-center rounded-full bg-paper text-lg text-pink-600 italic ring-1 ring-ink-200">
                &amp;
              </span>
              <Avatar user={partner} size={44} ring />
            </div>
            <h1 className="text-display-xl mt-8 font-normal text-balance md:mt-10">{info.title || '我们一起走过的地方'}</h1>
          </div>
          <div className="lg:col-span-4 lg:pb-2">
            {days != null && days > 0 ? (
              <div className="border-t border-ink-200 pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
                <p className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-[13px] text-ink-900">
                    <span className="size-1.5 rounded-full bg-pink-500" aria-hidden />
                    在一起
                  </span>
                  <span className="eyebrow">Days together</span>
                </p>
                <p className="mt-6 flex items-baseline gap-2 md:mt-8">
                  <span className="font-num text-[clamp(4.5rem,10vw,8.5rem)] leading-[0.8] font-light tracking-[-0.02em] text-ink-900">{days}</span>
                  <span className="text-xs text-ink-500">天</span>
                </p>
                <p className="caption font-num mt-4">since {dayjs(info.since).format('YYYY.MM.DD')}</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-10 items-center gap-2 text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
              >
                <CalendarHeart className="size-4 text-pink-600" strokeWidth={1.4} />
                设置在一起的纪念日
              </button>
            )}
          </div>
        </div>
      </header>

      {fpQ.isLoading ? (
        <div className="mt-16 h-[62vh] min-h-80 animate-pulse bg-ink-100 md:mt-24" />
      ) : fpQ.isLoadingError ? (
        <LoadError className="py-8" title="足迹加载失败" error={fpQ.error} onRetry={() => fpQ.refetch()} />
      ) : fpQ.data && (
        <>
          <FootprintStats data={fpQ.data} className="animate-slide-up mt-16 md:mt-24 [animation-delay:120ms] [animation-fill-mode:backwards]" accent="text-pink-500" />
          <section className="mt-10 md:mt-16" aria-label="共同足迹">
            {fpQ.data.stats.waypoints === 0 ? (
              <div className="border-t border-ink-200">
                <Empty
                  icon={<Heart className="size-10 text-pink-500" />}
                  title="还没有一起的足迹"
                  desc="创建旅程时打开「和 TA 一起」，你们的打卡就会出现在这里"
                  action={
                    <Button variant="love" icon={<Plus className="size-4" strokeWidth={1.5} />} onClick={() => nav('/trips/new')}>
                      规划一次一起的旅行
                    </Button>
                  }
                />
              </div>
            ) : (
              <Suspense fallback={<div className="h-[68svh] min-h-[26rem] animate-pulse border-t border-ink-200 bg-ink-100 md:h-[80vh]" />}>
                <FootprintsView
                  data={fpQ.data}
                  theme="love"
                  replayTo="/together/replay"
                  label="Atlas · 共同足迹"
                  bleed
                  height="h-[68svh] min-h-[26rem] md:h-[80vh] md:min-h-[36rem]"
                />
              </Suspense>
            )}
          </section>
        </>
      )}

      <section className="mt-24 md:mt-36">
        <LabelRow
          label="Trips · 旅程"
          count={sharedTrips.length ? <><span className="font-num">{tripsQ.data?.pages[0]?.total ?? sharedTrips.length}</span> 段</> : undefined}
          extra={
            <Link
              to="/trips/new"
              className="inline-flex h-10 items-center gap-1.5 text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
              新旅程
            </Link>
          }
        />
        <h2 className="text-display-md mt-8 mb-10 font-normal md:mt-12 md:mb-14">一起的旅程</h2>
        {tripsQ.isLoading ? (
          <TripGridSkeleton n={2} />
        ) : tripsQ.isLoadingError ? (
          <LoadError className="py-8" error={tripsQ.error} onRetry={() => tripsQ.refetch()} />
        ) : sharedTrips.length ? (
          <>
            <TripGrid trips={sharedTrips} />
            {tripsQ.hasNextPage && (
              <div className="mt-12 flex justify-center">
                <Button variant="outline" loading={tripsQ.isFetchingNextPage} onClick={() => tripsQ.fetchNextPage()}>
                  加载更多
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="caption">还没有一起的旅程</p>
        )}
      </section>

      {editing && <EditSpace info={info} onClose={() => setEditing(false)} onSaved={refresh} />}
      {unbinding && <UnbindDialog onClose={() => setUnbinding(false)} onUnbind={unbind} />}
    </div>
  )
}
