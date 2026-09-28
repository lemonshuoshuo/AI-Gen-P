import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Copy, Globe, ImageIcon, Link2, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripDetail, type Visibility } from '@/api'
import { Note, cityShort } from '@/components/editorial'
import { Button, Input, Modal, Spinner } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { copyText } from '@/lib/clipboard'
import { dateRange } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { categoryOf, visibilities } from '@/lib/meta'
import { bySeq, visitedInOrder } from '@/lib/trip'
import type { PosterOptions } from './SharePoster'

// 海报（canvas 绘制 + 二维码）只在点「生成分享海报」时加载
const PosterModal = lazy(() => import('./SharePoster').then((m) => ({ default: m.PosterModal })))

/** 次要操作：细线分隔的一行（图标 + 文字 + →），左缘与上面的内容对齐 */
function ActionRow({
  icon,
  children,
  onClick,
  loading,
  disabled,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className="group flex min-h-11 w-full items-center gap-3 py-2 text-left text-[14px] text-ink-800 transition-colors duration-300 hover:text-ink-900 disabled:opacity-50"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-500 transition-colors group-hover:text-ink-900">
          {loading ? <Spinner className="size-3.5" /> : icon}
        </span>
        <span className="min-w-0 flex-1">{children}</span>
        <span aria-hidden className="text-ink-400 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-ink-900">
          →
        </span>
      </button>
    </li>
  )
}

/** 二维码、链接、复制、系统分享：旅程、地点、打卡点共用（二维码库按需加载）；children 是更多的 ActionRow */
function ShareBody({ url, title, text, children }: { url: string; title: string; text?: string; children?: ReactNode }) {
  const { data: site } = useSite()
  const [qr, setQr] = useState('')
  useEffect(() => {
    let cancelled = false
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#0b0b0a', light: '#f2eee6' } }))
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
  const canShare = 'share' in navigator
  return (
    <div className="space-y-5">
      {/* 左边二维码（象牙白底才扫得出），一条细虚线，右边标题：不再套一层边框 */}
      <div className="flex items-stretch gap-5">
        <div className="flex shrink-0 items-center">
          {qr ? (
            <img src={qr} alt="二维码" className="size-28 rounded-sm sm:size-32" />
          ) : (
            <div className="size-28 animate-pulse rounded-sm bg-ink-100 sm:size-32" aria-hidden />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between border-l border-dashed border-ink-300 py-1 pl-5">
          <div className="min-w-0">
            <p className="eyebrow">Scan · 扫码打开</p>
            <p className="font-display mt-2 line-clamp-2 text-[1.3rem] leading-snug text-ink-900 [font-variant-numeric:lining-nums]">{title}</p>
            {text && <p className="caption mt-1 line-clamp-2">{text}</p>}
          </div>
          <p className="caption mt-3 text-[12px] text-balance">微信扫一扫，或长按保存二维码</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="分享链接" className="text-[13px] text-ink-600" />
        <Button onClick={copy} icon={<Copy className="size-4" strokeWidth={1.5} />}>
          复制
        </Button>
      </div>
      {(canShare || children) && (
        <ul className="divide-y divide-ink-200 border-y border-ink-200">
          {canShare && (
            <ActionRow icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={native}>
              系统分享
            </ActionRow>
          )}
          {children}
        </ul>
      )}
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
      <div className="pt-1">
        <ShareBody url={url} title={title} text={text} />
      </div>
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
      lead: trip.cities[0] ? cityShort(trip.cities[0]) : undefined,
      seed: trip.id,
      stamp: trip.days ? { value: String(trip.days).padStart(2, '0'), unit: trip.days > 1 ? 'DAYS' : 'DAY' } : undefined,
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
            <div className="space-y-5">
              <Note tone="amber" label="Private">
                这段旅程目前是「私密」的，只有你和共同作者能看到。选一种方式开启分享：
              </Note>
              <div>
                <Button
                  block
                  icon={<Link2 className="size-4" strokeWidth={1.5} />}
                  loading={saving === 'unlisted'}
                  disabled={!!saving}
                  onClick={() => changeVisibility('unlisted')}
                >
                  设为「链接可见」并分享
                </Button>
                <p className="caption mt-2 text-center text-[12px]">{visibilities.unlisted.desc}</p>
              </div>
              <div>
                <Button
                  block
                  variant="outline"
                  icon={<Globe className="size-4" strokeWidth={1.5} />}
                  loading={saving === 'public'}
                  disabled={!!saving}
                  onClick={() => changeVisibility('public')}
                >
                  公开到发现广场
                </Button>
                <p className="caption mt-2 text-center text-[12px]">所有人可见，别人可以一键引用你的路线；照片和轨迹也会公开</p>
              </div>
            </div>
          ) : (
            <Note tone="amber" label="Private">
              {trip.is_owner
                ? '这段旅程目前是「私密」的，只有你和共同作者能看到。可在编辑页把可见范围改成「链接可见」或「公开」后再分享。'
                : '这段旅程目前是「私密」的，只有作者可以修改可见范围。'}
            </Note>
          )
        ) : !url ? (
          <Note tone="amber" label="Unlisted">
            这段旅程为「链接可见」，只有作者和共同作者可以获取分享链接。
          </Note>
        ) : (
          <div className="space-y-4">
            <p className="border-b border-ink-200 pb-4">
              <span className="block text-[13px] text-ink-900">
                <span className="eyebrow mr-2">Visibility</span>
                {visibilities[trip.visibility].label}
              </span>
              <span className="caption block">{visibilities[trip.visibility].desc}</span>
            </p>
            {trip.visibility === 'public' && trip.status === 'pending' && (
              <Note tone="amber" label="Pending">
                审核中：通过前其他人打不开这个链接，也不会在发现广场看到
              </Note>
            )}
            <ShareBody url={url} title={trip.title} text={trip.summary || '来看看这段旅程'}>
              <ActionRow icon={<ImageIcon className="size-4" strokeWidth={1.5} />} onClick={openPoster}>
                生成分享海报
              </ActionRow>
              {trip.is_owner && trip.visibility === 'unlisted' && (
                <ActionRow icon={<RefreshCw className="size-4" strokeWidth={1.5} />} onClick={reset}>
                  重置分享链接
                </ActionRow>
              )}
              {trip.is_owner && trip.visibility === 'unlisted' && onUpdated && (
                <ActionRow icon={<Globe className="size-4" strokeWidth={1.5} />} loading={saving === 'public'} onClick={() => changeVisibility('public')}>
                  公开到发现广场
                </ActionRow>
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
