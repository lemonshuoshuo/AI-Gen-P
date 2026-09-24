import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripDetail } from '@/api'
import { Button, Input, Modal } from '@/components/ui'
import { visibilities } from '@/lib/meta'

export function ShareDialog({ trip, open, onClose }: { trip: TripDetail; open: boolean; onClose: () => void }) {
  const [code, setCode] = useState(trip.share_code)
  const [qr, setQr] = useState('')
  useEffect(() => setCode(trip.share_code), [trip.share_code])
  const url =
    trip.visibility === 'public' || !code
      ? `${window.location.origin}/trips/${trip.id}`
      : `${window.location.origin}/s/${code}`

  useEffect(() => {
    if (!open) return
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1c1b22', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''))
  }, [url, open])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${trip.title} | TripHub\n${url}`)
      toast.success('链接已复制')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }
  const native = async () => {
    try {
      await navigator.share({ title: trip.title, text: trip.summary || '来看看这段旅程', url })
    } catch {
      /* 用户取消 */
    }
  }
  const reset = async () => {
    try {
      const r = await api.trips.resetShareCode(trip.id)
      setCode(r.share_code)
      toast.success('已重置，旧链接失效')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="分享旅程">
      {trip.visibility === 'private' ? (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">
          这段旅程目前是「私密」的，只有你和共同作者能看到。可在编辑页把可见范围改成「链接可见」或「公开」后再分享。
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-500">
            当前可见范围：<b>{visibilities[trip.visibility].label}</b> · {visibilities[trip.visibility].desc}
          </p>
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
            {trip.is_owner && trip.visibility === 'unlisted' && (
              <Button variant="ghost" size="sm" onClick={reset} icon={<RefreshCw className="size-4" />}>
                重置分享链接
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
