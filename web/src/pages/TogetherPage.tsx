import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarHeart, Heart, HeartCrack, PenLine, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type PartnerInfo } from '@/api'
import { FootprintStats, FootprintsView } from '@/components/three/FootprintsView'
import { TripGrid } from '@/components/trip/TripCard'
import { Avatar, Button, Card, Empty, Field, Input, Menu, MenuItem, Modal, PageLoader, UserName, confirmDialog } from '@/components/ui'
import { dayjs, fromNow } from '@/lib/format'
import { useAuth } from '@/stores/auth'

function Invites({ info, refresh }: { info: PartnerInfo; refresh: () => void }) {
  const [username, setUsername] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const refreshMe = useAuth((s) => s.refreshMe)
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast.success(ok)
      refresh()
      refreshMe()
    } catch (e) {
      toast.error(errorMessage(e))
    }
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
            <Button variant="ghost" size="sm" onClick={() => act(() => api.partner.decline(inv.id), '已拒绝')}>
              婉拒
            </Button>
            <Button variant="love" size="sm" icon={<Heart className="size-4" />} onClick={() => act(() => api.partner.accept(inv.id), '绑定成功 💕')}>
              接受
            </Button>
          </div>
        </Card>
      ))}

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">邀请 TA</h3>
        <Field label="对方的用户名">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="让 TA 先注册一个账号" />
        </Field>
        <Field label="想说的话（可选）">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={100} placeholder="以后的旅行，都一起记录吧" />
        </Field>
        <Button
          block
          variant="love"
          loading={sending}
          disabled={!username.trim()}
          icon={<Send className="size-4" />}
          onClick={async () => {
            setSending(true)
            await act(() => api.partner.invite(username.trim(), message.trim() || undefined), '邀请已发送，等 TA 接受吧')
            setUsername('')
            setMessage('')
            setSending(false)
          }}
        >
          发送邀请
        </Button>
      </Card>

      {info.invites.outgoing.map((inv) => (
        <Card key={inv.id} className="flex items-center gap-3 p-4">
          <Avatar user={inv.to} size={36} />
          <div className="min-w-0 flex-1 text-sm">
            已邀请 <b>{inv.to.nickname || inv.to.username}</b>，等待对方接受
          </div>
          <Button variant="ghost" size="sm" onClick={() => act(() => api.partner.cancel(inv.id), '已撤回')}>
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
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="我们一起走过的地方" maxLength={40} />
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
  const tripsQ = useQuery({ queryKey: ['partner-trips'], queryFn: () => api.partner.trips({ page_size: 50 }), enabled: !!partner })
  const [editing, setEditing] = useState(false)

  if (infoQ.isLoading) return <PageLoader />
  const info = infoQ.data
  if (!info) return <Empty title="加载失败" desc={errorMessage(infoQ.error)} />
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['partner'] })
    qc.invalidateQueries({ queryKey: ['partner-footprints'] })
  }

  if (!partner)
    return (
      <div className="px-4 py-6">
        <Invites info={info} refresh={refresh} />
      </div>
    )

  const days = info.since ? dayjs().startOf('day').diff(dayjs(info.since), 'day') + 1 : null
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
      <div className="bg-love-gradient relative overflow-hidden rounded-3xl p-6 text-white">
        <Heart className="absolute -right-8 -bottom-10 size-52 fill-white/10 text-white/10" />
        <div className="relative flex flex-wrap items-center gap-5">
          <div className="flex items-center">
            <Avatar user={me} size={64} ring />
            <Heart className="-mx-2 z-10 size-8 animate-pulse fill-white text-white drop-shadow" />
            <Avatar user={partner} size={64} ring />
          </div>
          <div className="min-w-0 flex-1">
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
          <Menu
            trigger={(t) => (
              <button type="button" onClick={t} className="rounded-full bg-white/20 px-3 py-1.5 text-sm backdrop-blur hover:bg-white/30">
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
        {!info.since && (
          <button type="button" onClick={() => setEditing(true)} className="relative mt-4 flex items-center gap-1.5 text-sm text-white/90 underline">
            <CalendarHeart className="size-4" />
            设置在一起的纪念日
          </button>
        )}
      </div>

      {fpQ.data && (
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
              <FootprintsView data={fpQ.data} theme="love" replayTo="/together/replay" />
            )}
          </div>
        </>
      )}

      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">一起的旅程</h2>
        <Link to="/trips/new">
          <Button size="sm" variant="love" icon={<Plus className="size-4" />}>
            新旅程
          </Button>
        </Link>
      </div>
      {tripsQ.data?.items.length ? <TripGrid trips={tripsQ.data.items} /> : <p className="text-sm text-ink-400">还没有一起的旅程</p>}

      <EditSpace info={info} open={editing} onClose={() => setEditing(false)} onSaved={refresh} />
    </div>
  )
}
