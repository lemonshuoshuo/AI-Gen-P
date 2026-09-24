// 旅程分享海报：朋友圈、小红书以图片为主（小红书不能发链接），在浏览器里用 canvas 画一张竖图
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Download, Share2 } from 'lucide-react'
import { Button, Modal, Spinner, buttonClass } from '@/components/ui'

type LngLat = [number, number]

export interface PosterOptions {
  title: string
  subtitle?: string
  /** unit 用小一号的字写在数字后面（如「12.3」「公里」） */
  stats: { label: string; value: string; unit?: string }[]
  coverUrl?: string
  /** 路线（经纬度），只画示意线，不画地图底图 */
  path: LngLat[]
  dots?: { lng: number; lat: number; color: string }[]
  /** 二维码指向的链接（私密内容不要传） */
  qrUrl?: string
  siteName: string
  theme: 'brand' | 'love'
}

const W = 1080
const H = 1620
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const THEMES = {
  brand: { from: '#ff5a5f', to: '#ff9a44', tagline: '记录旅程 · 分享路线 · 打卡避雷' },
  love: { from: '#ff6b9d', to: '#c56cf0', tagline: '我们一起走过的地方' },
}

function loadImg(src: string, cors = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 外链封面没有 CORS 头时会加载失败（跳过封面）；不设置的话画布被污染，最后无法导出图片
    if (cors) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

// 不用 ctx.roundRect：较旧的 iOS / 微信内核没有
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 按宽度折行（中文没有空格，逐字测量）；放不下时最后一行以省略号结尾 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number) {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  const lines: string[] = []
  let line = ''
  let overflow = false
  for (const ch of chars) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      lines.push(line)
      line = ch
      if (lines.length === maxLines) {
        overflow = true
        break
      }
    } else line += ch
  }
  if (!overflow) {
    lines.push(line)
    return lines
  }
  const last = [...lines[maxLines - 1]]
  while (last.length && ctx.measureText(last.join('') + '…').width > maxW) last.pop()
  lines[maxLines - 1] = last.join('') + '…'
  return lines
}

/** 等同 object-fit: cover */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = w / s
  const sh = h / s
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h)
}

/** 路线示意：经度按平均纬度压缩后等比缩放到框内 */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  path: LngLat[],
  dots: { lng: number; lat: number; color: string }[],
  box: { x: number; y: number; w: number; h: number },
  colors: [string, string],
) {
  const all: LngLat[] = [...path, ...dots.map((d) => [d.lng, d.lat] as LngLat)]
  if (!all.length) return
  const k = Math.cos((all.reduce((a, p) => a + p[1], 0) / all.length) * (Math.PI / 180))
  const xs = all.map((p) => p[0] * k)
  const ys = all.map((p) => -p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const pad = 44
  const spanX = maxX - minX
  const spanY = maxY - minY
  // 只有一个点（或所有点重合）时画在正中；只在一个方向上有跨度时按那个方向缩放
  const s =
    spanX > 0 || spanY > 0
      ? Math.min(spanX > 0 ? (box.w - 2 * pad) / spanX : Infinity, spanY > 0 ? (box.h - 2 * pad) / spanY : Infinity)
      : 0
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const at = (p: LngLat): LngLat => [cx + (p[0] * k - (minX + maxX) / 2) * s, cy + (-p[1] - (minY + maxY) / 2) * s]

  if (path.length > 1) {
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h)
    g.addColorStop(0, colors[0])
    g.addColorStop(1, colors[1])
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = g
    ctx.lineWidth = 8
    ctx.beginPath()
    path.forEach((p, i) => {
      const [x, y] = at(p)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }
  for (const d of dots) {
    const [x, y] = at([d.lng, d.lat])
    ctx.beginPath()
    ctx.arc(x, y, 12, 0, Math.PI * 2)
    ctx.fillStyle = d.color
    ctx.fill()
    ctx.lineWidth = 5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
}

/** 画海报，返回 JPEG 的 data URL（微信里长按保存不支持 blob: 链接） */
export async function drawPoster(o: PosterOptions): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('海报生成失败')
  const theme = THEMES[o.theme]
  try {
    ctx.textBaseline = 'top'
    const bg = ctx.createLinearGradient(0, 0, W, H)
    bg.addColorStop(0, theme.from)
    bg.addColorStop(1, theme.to)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    // 顶部封面；没有封面或加载失败时在渐变上写站点名
    const coverH = 620
    let cover = false
    if (o.coverUrl) {
      try {
        drawCover(ctx, await loadImg(o.coverUrl, true), 0, 0, W, coverH)
        cover = true
      } catch {
        /* 跳过封面 */
      }
    }
    if (!cover) {
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold 48px ${FONT}`
      ctx.fillText(wrap(ctx, o.siteName, W - 208, 1)[0], 104, 110)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.font = `32px ${FONT}`
      ctx.fillText(theme.tagline, 104, 180)
    }

    // 白色卡片
    const card = { x: 48, y: coverH - 80, w: W - 96, h: H - (coverH - 80) - 48 }
    ctx.save()
    ctx.shadowColor = 'rgba(28,27,34,0.18)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetY = 12
    roundRectPath(ctx, card.x, card.y, card.w, card.h, 40)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.restore()

    const px = card.x + 56
    const pw = card.w - 112
    let y = card.y + 56

    ctx.fillStyle = '#1c1b22'
    ctx.font = `bold 60px ${FONT}`
    for (const line of wrap(ctx, o.title, pw, 2)) {
      ctx.fillText(line, px, y)
      y += 76
    }
    if (o.subtitle) {
      ctx.fillStyle = '#6b6878'
      ctx.font = `32px ${FONT}`
      ctx.fillText(wrap(ctx, o.subtitle, pw, 1)[0], px, y + 4)
      y += 56
    }
    y += 24

    const colW = pw / Math.max(1, o.stats.length)
    o.stats.forEach((s, i) => {
      const sx = px + i * colW
      const unit = s.unit ? ` ${s.unit}` : ''
      // 数字和单位按基线对齐；一栏放不下时缩小字号
      let size = 48
      const width = () => {
        ctx.font = `26px ${FONT}`
        const uw = ctx.measureText(unit).width
        ctx.font = `bold ${size}px ${FONT}`
        return ctx.measureText(s.value).width + uw
      }
      while (size > 28 && width() > colW - 16) size -= 2
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#1c1b22'
      ctx.font = `bold ${size}px ${FONT}`
      const vw = ctx.measureText(s.value).width
      ctx.fillText(s.value, sx, y + 44)
      if (unit) {
        ctx.fillStyle = '#6b6878'
        ctx.font = `26px ${FONT}`
        ctx.fillText(unit, sx + vw, y + 44)
      }
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#9895a5'
      ctx.font = `26px ${FONT}`
      ctx.fillText(s.label, sx, y + 62)
    })
    y += 120

    // 底部：站点名 + 二维码
    const qs = 220
    const qy = card.y + card.h - 56 - qs
    const routeBottom = qy - 40
    if (routeBottom - y > 120 && (o.path.length || o.dots?.length)) {
      const box = { x: px, y, w: pw, h: routeBottom - y }
      roundRectPath(ctx, box.x, box.y, box.w, box.h, 28)
      ctx.fillStyle = '#faf9fc'
      ctx.fill()
      drawRoute(ctx, o.path, o.dots ?? [], box, [theme.from, theme.to])
    }

    if (o.qrUrl) {
      const qr = await loadImg(await QRCode.toDataURL(o.qrUrl, { margin: 1, width: 260, color: { dark: '#1c1b22', light: '#ffffff' } }))
      const qx = px + pw - qs
      ctx.drawImage(qr, qx, qy, qs, qs)
      ctx.fillStyle = '#9895a5'
      ctx.font = `24px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText('长按识别二维码', qx + qs / 2, qy + qs + 12)
      ctx.textAlign = 'left'
    }
    const textW = pw - (o.qrUrl ? qs + 32 : 0)
    ctx.fillStyle = theme.from
    ctx.font = `bold 44px ${FONT}`
    ctx.fillText(wrap(ctx, o.siteName, textW, 1)[0], px, qy + 48)
    ctx.fillStyle = '#6b6878'
    ctx.font = `28px ${FONT}`
    ctx.fillText(o.qrUrl ? '扫码查看完整路线和打卡点评' : theme.tagline, px, qy + 118)

    return canvas.toDataURL('image/jpeg', 0.9)
  } finally {
    // 立即释放画布内存（iOS 要等回收才释放）
    canvas.width = 0
    canvas.height = 0
  }
}

function dataUrlToFile(dataUrl: string, name: string) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/jpeg' })
}

/** 生成并展示海报：手机上长按保存，电脑上下载；支持时可以直接通过系统分享发图片 */
export function PosterModal({ options, name, onClose }: { options: PosterOptions | null; name: string; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const filename = `${name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'triphub'}.jpg`

  useEffect(() => {
    if (!options) return
    let cancelled = false
    setUrl('')
    setFile(null)
    setError('')
    drawPoster(options)
      .then((u) => {
        if (cancelled) return
        setUrl(u)
        const f = dataUrlToFile(u, filename)
        if (navigator.canShare?.({ files: [f] })) setFile(f)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : '海报生成失败'))
    return () => {
      cancelled = true
    }
  }, [options, filename])

  const share = async () => {
    if (!file) return
    try {
      await navigator.share({ files: [file], title: options?.title })
    } catch {
      /* 用户取消 */
    }
  }

  return (
    <Modal open={!!options} onClose={onClose} title="分享海报">
      {error ? (
        <p className="py-12 text-center text-sm text-red-600">{error}</p>
      ) : !url ? (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-ink-400">
          <Spinner className="size-7" />
          正在生成海报…
        </div>
      ) : (
        <div className="space-y-3">
          <img src={url} alt="分享海报" className="mx-auto max-h-[60dvh] w-auto rounded-2xl shadow-card" />
          <p className="text-center text-xs text-ink-400">长按图片保存，发朋友圈 / 小红书</p>
          <div className="flex justify-center gap-2">
            <a href={url} download={filename} className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <Download className="size-4" />
              保存图片
            </a>
            {file && (
              <Button size="sm" icon={<Share2 className="size-4" />} onClick={share}>
                分享图片
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
