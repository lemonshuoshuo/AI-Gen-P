import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Copy, Globe, ImageIcon, Link2, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripDetail, type Visibility } from '@/api'
import { Button, Input, Modal } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { copyText } from '@/lib/clipboard'
import { dateRange } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { categoryOf, visibilities } from '@/lib/meta'
import { bySeq, visitedInOrder } from '@/lib/trip'
import type { PosterOptions } from './SharePoster'

// 海报（canvas 绘制 + 二维码）只在点「生成分享海报」时加载
const PosterModal = lazy(() => import('./SharePoster').then((m) => ({ default: m.PosterModal })))

/** 二维码、链接、复制、系统分享：旅程、地点、打卡点共用（二维码库按需加载） */
function ShareBody({ url, title, text, children }: { url: string; title: string; text?: string; children?: ReactNode }) {
  const { data: site } = useSite()
  const [qr, setQr] = useState('')
  useEffect(() => {
    let cancelled = false
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1c1b22', light: '#ffffff' } }))
      .then((d) => !cancelled && setQr(d))
      .catch(() => !cancelled && setQr(''))
    return () => {
      cancelled = true
    }
  }, [url])

  const copy = async () => {
    if (await copyText(`${title} | ${site?.name || 'TripHub'}\n${url}`)) toast.success('链接已复制')
    else toast.error('复制失败，请长按上方链接手动复制')
  }
  const native = async () => {
    try {
      await navigator.share({ title, text, url })
    } catch {
      /* 用户取消 */
    }
  }
  return (
    <div className="space-y-4">
      {qr && (
        <div className="flex flex-col items-center">
          <img src={qr} alt="二维码" className="size-44 rounded-2xl ring-1 ring-ink-100" />
          <span className="mt-2 text-xs text-ink-400">微信扫一扫，或长按保存二维码</span>
        </div>
      )}
      <div className="flex gap-2">
        <Input readOnly value={url} onFocus={(e) => e.target.select()} />
        <Button onClick={copy} icon={<Copy className="size-4" />}>
          复制
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {'share' in navigator && (
          <Button variant="outline" size="sm" onClick={native} icon={<Share2 className="size-4" />}>
            系统分享
          </Button>
        )}
        {children}
      </div>
    </div>
  )
}

/** 通用分享弹窗（地点、单个打卡点等）：链接、二维码、复制、系统分享 */
export function ShareSheet({
  open,
  onClose,
  title,
  text,
  url,
  heading = '分享',
}: {
  open: boolean
  onClose: () => void
  title: string
  text?: string
  url: string
  heading?: string
}) {
  return (
    <Modal open={open} onClose={onClose} title={heading}>
      <p className="mb-4 line-clamp-2 text-sm text-ink-500">
        <b className="text-ink-900">{title}</b>
        {text && ` · ${text}`}
      </p>
      <ShareBody url={url} title={title} text={text} />
    </Modal>
  )
}

/**
 * shareCode：访问者打开旅程时用的分享码（非成员拿不到 trip.share_code）
 * onUpdated：作者在这里修改可见范围后回传新的旅程（传入后私密旅程才显示「开启分享」按钮）
 */
export function ShareDialog({
  trip,
  shareCode,
  open,
  onClose,
  onUpdated,
}: {
  trip: TripDetail
  shareCode?: string
  open: boolean
  onClose: () => void
  onUpdated?: (t: TripDetail) => void
}) {
  const { data: site } = useSite()
  const [code, setCode] = useState(trip.share_code)
  const [saving, setSaving] = useState<Visibility | null>(null)
  const [poster, setPoster] = useState<PosterOptions | null>(null)
  useEffect(() => setCode(trip.share_code), [trip.share_code])
  const known = code ?? shareCode
  // 「链接可见」的旅程只能通过 /s/分享码 访问，/trips/:id 对非成员是 404；不知道分享码时不给链接
  const url =
    trip.visibility === 'public'
      ? `${window.location.origin}/trips/${trip.id}`
      : known
        ? `${window.location.origin}/s/${known}`
        : ''

  const reset = async () => {
    try {
      const r = await api.trips.resetShareCode(trip.id)
      setCode(r.share_code)
      toast.success('已重置，旧链接失效')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const changeVisibility = async (v: Visibility) => {
    setSaving(v)
    try {
      const t = await api.trips.update(trip.id, { visibility: v })
      onUpdated?.(t)
      // 站点开启了「公开旅程需审核」：公开后先进入审核队列
      if (t.status === 'pending')
        toast.success('已提交审核', { description: '管理员审核通过后才会出现在发现广场，在此之前只有你和共同作者能看到' })
      else toast.success(v === 'public' ? '已公开到发现广场' : '已开启链接分享')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  // 海报上的路线：有打卡时画实际路线（与详情页同样的顺序），否则画计划路线
  const openPoster = () => {
    const visited = visitedInOrder(trip.waypoints)
    const shown = visited.length ? visited : trip.waypoints.filter((w) => w.planned).sort(bySeq)
    const km = formatKm(trip.distance_km) // 如「12.3 公里」「850 米」
    onClose()
    setPoster({
      title: trip.title,
      subtitle: [trip.author.nickname || trip.author.username, dateRange(trip.start_date, trip.end_date)].filter(Boolean).join(' · '),
      stats: [
        { label: '天数', value: trip.days ? String(trip.days) : '-', unit: trip.days ? '天' : undefined },
        { label: '里程', value: km.replace(/ .*/, ''), unit: km.replace(/^[\d.,]+ /, '') },
        { label: '城市', value: String(trip.cities.length), unit: '个' },
        { label: '打卡点', value: String(trip.waypoint_count) },
      ],
      coverUrl: trip.cover_url || undefined,
      path: shown.map((w) => [w.lng, w.lat] as [number, number]),
      dots: shown.map((w) => ({ lng: w.lng, lat: w.lat, color: categoryOf(w.category).color })),
      qrUrl: url,
      siteName: site?.name || 'TripHub',
      theme: trip.together ? 'love' : 'brand',
    })
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="分享旅程">
        {trip.visibility === 'private' ? (
          trip.is_owner && onUpdated ? (
            <div className="space-y-3">
              <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
                这段旅程目前是「私密」的，只有你和共同作者能看到。选一种方式开启分享：
              </div>
              <div>
                <Button
                  block
                  icon={<Link2 className="size-4" />}
                  loading={saving === 'unlisted'}
                  disabled={!!saving}
                  onClick={() => changeVisibility('unlisted')}
                >
                  设为「链接可见」并分享
                </Button>
                <p className="mt-1 text-center text-xs text-ink-400">{visibilities.unlisted.desc}</p>
              </div>
              <div>
                <Button
                  block
                  variant="outline"
                  icon={<Globe className="size-4" />}
                  loading={saving === 'public'}
                  disabled={!!saving}
                  onClick={() => changeVisibility('public')}
                >
                  公开到发现广场
                </Button>
                <p className="mt-1 text-center text-xs text-ink-400">所有人可见，别人可以一键引用你的路线；照片和轨迹也会公开</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
              {trip.is_owner
                ? '这段旅程目前是「私密」的，只有你和共同作者能看到。可在编辑页把可见范围改成「链接可见」或「公开」后再分享。'
                : '这段旅程目前是「私密」的，只有作者可以修改可见范围。'}
            </div>
          )
        ) : !url ? (
          <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
            这段旅程为「链接可见」，只有作者和共同作者可以获取分享链接。
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-500">
              当前可见范围：<b>{visibilities[trip.visibility].label}</b> · {visibilities[trip.visibility].desc}
            </p>
            {trip.visibility === 'public' && trip.status === 'pending' && (
              <div className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">审核中：通过前其他人打不开这个链接，也不会在发现广场看到</div>
            )}
            <ShareBody url={url} title={trip.title} text={trip.summary || '来看看这段旅程'}>
              <Button variant="outline" size="sm" onClick={openPoster} icon={<ImageIcon className="size-4" />}>
                生成分享海报
              </Button>
              {trip.is_owner && trip.visibility === 'unlisted' && (
                <Button variant="ghost" size="sm" onClick={reset} icon={<RefreshCw className="size-4" />}>
                  重置分享链接
                </Button>
              )}
              {trip.is_owner && trip.visibility === 'unlisted' && onUpdated && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={saving === 'public'}
                  onClick={() => changeVisibility('public')}
                  icon={<Globe className="size-4" />}
                >
                  公开到发现广场
                </Button>
              )}
            </ShareBody>
          </div>
        )}
      </Modal>
      {poster && (
        <Suspense fallback={null}>
          <PosterModal options={poster} name={trip.title} onClose={() => setPoster(null)} />
        </Suspense>
      )}
    </>
  )
}
