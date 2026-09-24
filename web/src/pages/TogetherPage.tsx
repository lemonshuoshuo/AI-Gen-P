import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarHeart, Copy, Heart, HeartCrack, PenLine, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type PartnerInfo } from '@/api'
import { FootprintStats } from '@/components/three/FootprintStats'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import {
  Avatar,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LoadError,
  Menu,
  MenuItem,
  Modal,
  PageLoader,
  UserName,
  buttonClass,
  confirmDialog,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useSite } from '@/hooks/useSite'
import { copyText } from '@/lib/clipboard'
import { dayjs, fromNow } from '@/lib/format'
import { flattenPages } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

// 共同足迹地图（maplibre + deck.gl）只在绑定情侣空间后显示：按需加载，还没绑定时只看到邀请表单
const loadFootprintsView = () => import('@/components/three/FootprintsView')
const FootprintsView = lazy(() => loadFootprintsView().then((m) => ({ default: m.FootprintsView })))

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
    <div className="mx-auto max-w-lg space-y-5">
      <div className="bg-love-gradient relative overflow-hidden rounded-3xl p-6 text-white">
        <Heart className="absolute -right-6 -bottom-6 size-40 fill-white/10 text-white/10" />
        <h1 className="text-2xl font-extrabold">我们一起走过的地方</h1>
        <p className="mt-2 text-sm text-white/80">
          和 TA 绑定情侣空间：一起的旅程会汇成共同的足迹地图，点亮你们一起去过的城市，还能 3D 回放你们的每一段路。
        </p>
      </div>

      {info.invites.incoming.map((inv) => (
        <Card key={inv.id} className="p-4">
          <div className="flex items-center gap-3">
            <Avatar user={inv.from} size={44} />
            <div className="min-w-0 flex-1">
              <UserName user={inv.from} />
              <div className="text-xs text-ink-400">{fromNow(inv.created_at)} 邀请你绑定情侣空间</div>
            </div>
          </div>
          {inv.message && <p className="mt-3 rounded-xl bg-pink-50 p-3 text-sm text-pink-900">“{inv.message}”</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              loading={busy === `decline-${inv.id}`}
              onClick={() => act(`decline-${inv.id}`, () => api.partner.decline(inv.id), '已拒绝')}
            >
              婉拒
            </Button>
            <Button
              variant="love"
              size="sm"
              icon={<Heart className="size-4" />}
              disabled={!!busy}
              loading={busy === `accept-${inv.id}`}
              onClick={() => act(`accept-${inv.id}`, () => api.partner.accept(inv.id), '绑定成功 💕')}
            >
              接受
            </Button>
          </div>
        </Card>
      ))}

      {linked && (
        <p className="rounded-2xl bg-pink-50 px-4 py-3 text-sm text-pink-900">
          {linkedInvited
            ? `@${linked} 已经邀请你了，点上面的「接受」就绑定啦`
            : `@${linked} 邀请你绑定情侣空间，点「发送邀请」，TA 确认后就绑定啦`}
        </p>
      )}

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">邀请 TA</h3>
        <Field label="对方的用户名">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入 TA 的用户名，或把下方邀请链接发给 TA" />
        </Field>
        <Field label="想说的话（可选）">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={100} placeholder="以后的旅行，都一起记录吧" />
        </Field>
        <Button
          block
          variant="love"
          loading={busy === 'send'}
          disabled={!username.trim() || !!busy}
          icon={<Send className="size-4" />}
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
        <div className="space-y-2 border-t border-ink-100 pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <h4 className="text-sm font-semibold">把邀请链接发给 TA</h4>
            <span className="text-xs text-ink-400">我的用户名 @{me.username}</span>
          </div>
          <div className="flex gap-2">
            <Input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} aria-label="邀请链接" />
            <Button variant="outline" icon={<Copy className="size-4" />} onClick={copyInvite}>
              复制邀请链接
            </Button>
          </div>
          <p className="text-xs text-ink-400">TA 打开链接、注册或登录后点「发送邀请」，你在通知里接受就绑定啦</p>
        </div>
      </Card>

      {info.invites.outgoing.map((inv) => (
        <Card key={inv.id} className="flex items-center gap-3 p-4">
          <Avatar user={inv.to} size={36} />
          <div className="min-w-0 flex-1 text-sm">
            已邀请 <b>{inv.to.nickname || inv.to.username}</b>，等待对方接受
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!busy}
            loading={busy === `cancel-${inv.id}`}
            onClick={() => act(`cancel-${inv.id}`, () => api.partner.cancel(inv.id), '已撤回')}
          >
            撤回
          </Button>
        </Card>
      ))}
    </div>
  )
}

function EditSpace({ info, open, onClose, onSaved }: { info: PartnerInfo; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(info.title)
  const [since, setSince] = useState(info.since ?? '')
  const [saving, setSaving] = useState(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="编辑我们的空间"
      footer={
        <Button
          variant="love"
          loading={saving}
          onClick={async () => {
            setSaving(true)
            try {
              await api.partner.update({ title: title.trim(), since: since || null })
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
          <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </Field>
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

  if (!partner)
    return (
      <div className="px-4 py-6">
        <Invites info={info} refresh={refresh} />
      </div>
    )

  const days = info.since ? dayjs().startOf('day').diff(dayjs(info.since), 'day') + 1 : null
  const sharedTrips = flattenPages(tripsQ.data?.pages)
  const unbind = async () => {
    if (!(await confirmDialog({ title: '解除情侣空间？', desc: '一起的旅程不会被删除，但共同足迹页面将不再显示。', danger: true, okText: '解除' })))
      return
    try {
      await api.partner.unbind()
      refreshMe()
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* 卡片本身不裁剪：「设置」菜单要能超出卡片；只裁剪装饰的大爱心 */}
      <div className="bg-love-gradient relative rounded-3xl p-6 text-white">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
          <Heart className="absolute -right-8 -bottom-10 size-52 fill-white/10 text-white/10" />
        </div>
        {/* 手机上头像和「设置」一行，标题单独一行（否则标题被挤成一两个字一行） */}
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center">
            <Avatar user={me} size={64} ring />
            <Heart className="-mx-2 z-10 size-8 animate-pulse fill-white text-white drop-shadow" />
            <Avatar user={partner} size={64} ring />
          </div>
          <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
            <h1 className="text-2xl font-extrabold">{info.title || '我们一起走过的地方'}</h1>
            <p className="mt-1 text-sm text-white/85">
              {me.nickname || me.username} & {partner.nickname || partner.username}
              {days != null && days > 0 && (
                <>
                  {' · '}在一起 <b className="text-lg">{days}</b> 天
                </>
              )}
            </p>
          </div>
          <div className="ml-auto">
            <Menu
              trigger={(t, open) => (
                <button
                  type="button"
                  onClick={t}
                  aria-expanded={open}
                  className="rounded-full bg-white/20 px-3 py-1.5 text-sm backdrop-blur hover:bg-white/30"
                >
                  设置
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={<PenLine className="size-4" />} onClick={() => (close(), setEditing(true))}>
                    编辑名称和纪念日
                  </MenuItem>
                  <MenuItem icon={<HeartCrack className="size-4" />} danger onClick={() => (close(), unbind())}>
                    解除绑定
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
        {!info.since && (
          <button type="button" onClick={() => setEditing(true)} className="relative mt-4 flex items-center gap-1.5 text-sm text-white/90 underline">
            <CalendarHeart className="size-4" />
            设置在一起的纪念日
          </button>
        )}
      </div>

      {fpQ.isLoading ? (
        <div className="mt-5 h-[46vh] animate-pulse rounded-3xl bg-ink-100 sm:h-[62vh]" />
      ) : fpQ.isLoadingError ? (
        <LoadError className="py-8" title="足迹加载失败" error={fpQ.error} onRetry={() => fpQ.refetch()} />
      ) : fpQ.data && (
        <>
          <FootprintStats data={fpQ.data} className="mt-5" />
          <div className="mt-5">
            {fpQ.data.stats.waypoints === 0 ? (
              <Empty
                icon={<Heart className="size-12 text-pink-300" />}
                title="还没有一起的足迹"
                desc="创建旅程时打开「和 TA 一起」，你们的打卡就会出现在这里"
                action={
                  <Button variant="love" icon={<Plus className="size-4" />} onClick={() => nav('/trips/new')}>
                    规划一次一起的旅行
                  </Button>
                }
              />
            ) : (
              <Suspense fallback={<PageLoader />}>
                <FootprintsView data={fpQ.data} theme="love" replayTo="/together/replay" />
              </Suspense>
            )}
          </div>
        </>
      )}

      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">一起的旅程</h2>
        <Link to="/trips/new" className={buttonClass({ size: 'sm', variant: 'love' })}>
          <Plus className="size-4" />
          新旅程
        </Link>
      </div>
      {tripsQ.isLoading ? (
        <TripGridSkeleton n={2} />
      ) : tripsQ.isLoadingError ? (
        <LoadError className="py-8" error={tripsQ.error} onRetry={() => tripsQ.refetch()} />
      ) : sharedTrips.length ? (
        <>
          <TripGrid trips={sharedTrips} />
          {tripsQ.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" loading={tripsQ.isFetchingNextPage} onClick={() => tripsQ.fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-ink-400">还没有一起的旅程</p>
      )}

      <EditSpace info={info} open={editing} onClose={() => setEditing(false)} onSaved={refresh} />
    </div>
  )
}
