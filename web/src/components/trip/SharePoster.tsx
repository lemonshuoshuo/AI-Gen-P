// 旅程分享海报：朋友圈、小红书以图片为主（小红书不能发链接），在浏览器里用 canvas 画一张竖图
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Download, Share2 } from 'lucide-react'
import { mineralOf } from '@/components/editorial'
import { Button, Modal, Spinner, buttonClass } from '@/components/ui'

type LngLat = [number, number]

export interface PosterOptions {
  title: string
  subtitle?: string
  /** unit 用小一号的字写在数字后面（如「12.3」「公里」） */
  stats: { label: string; value: string; unit?: string }[]
  coverUrl?: string
  /** 没有封面照片时，封面色块上的大字（通常是第一个城市） */
  lead?: string
  /** 决定无封面时的矿物色（通常传旅程 id） */
  seed?: number
  /** 无封面时色块右上角的邮戳（如天数） */
  stamp?: { value: string; unit: string }
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
const M = 84
// 「旅行手账」：纸色底、墨色字、一点朱砂（情侣空间用胭脂）
const PAPER = '#f4f1ea'
const WHITE = '#fffdf9'
const INK = '#1b1a17'
const INK5 = '#615c53'
const INK4 = '#736d62'
const LINE = '#ddd6c8'
const SANS = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const SERIF = '"Cormorant Garamond Variable","Noto Serif SC","Songti SC","STSong",serif'
const NUM = '"Cormorant Garamond Variable",Georgia,"Noto Serif SC",serif'
const THEMES = {
  brand: { accent: '#bd462b', tagline: '记录旅程 · 分享路线 · 打卡避雷' },
  love: { accent: '#9d4a5f', tagline: '我们一起走过的地方' },
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

/** 画布用到的网页字体（宋体按字切片，要带上实际文字才会下载对应分片）；最多等 3 秒，超时就用系统字体 */
async function ensureFonts(samples: [font: string, text: string][]) {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load) return
  await Promise.race([
    Promise.all(samples.map(([f, t]) => fonts.load(f, t).catch(() => []))),
    new Promise((r) => setTimeout(r, 3000)),
  ])
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

/** 逐字加字距绘制（ctx.letterSpacing 在旧内核上不可用）；align=right 时 x 为右端 */
function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, gap: number, align: 'left' | 'right' = 'left') {
  const chars = [...text]
  const width = chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + gap * Math.max(0, chars.length - 1)
  let cx = align === 'right' ? x - width : x
  for (const c of chars) {
    ctx.fillText(c, cx, y)
    cx += ctx.measureText(c).width + gap
  }
  return width
}

/** 等同 object-fit: cover */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = w / s
  const sh = h / s
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h)
}

function hairline(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color = LINE, width = 2) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

/** 纸张噪点：小图块平铺，避免整张纯色 */
function grain(ctx: CanvasRenderingContext2D) {
  const tile = document.createElement('canvas')
  try {
    tile.width = tile.height = 128
    const t = tile.getContext('2d')
    if (!t) return
    const img = t.createImageData(128, 128)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 90
      img.data[i + 1] = 76
      img.data[i + 2] = 56
      img.data[i + 3] = Math.random() < 0.5 ? Math.floor(Math.random() * 16) : 0
    }
    t.putImageData(img, 0, 0)
    const pattern = ctx.createPattern(tile, 'repeat')
    if (!pattern) return
    ctx.save()
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  } finally {
    tile.width = tile.height = 0
  }
}

/** 邮戳：双圈 + 沿圈小字 + 中间大号数字 */
function postmark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  value: string,
  unit: string,
  ring: string,
) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((-9 * Math.PI) / 180)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2)
  ctx.stroke()
  // 沿圈的字：重复到约一整圈的长度，再均匀排开
  ctx.font = `500 ${Math.round(r * 0.15)}px ${NUM}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const circ = 2 * Math.PI * r * 0.83
  const unitText = ring.toUpperCase()
  let text = unitText
  while (ctx.measureText(text + unitText).width + (text.length + unitText.length) * r * 0.05 < circ) text += unitText
  const chars = [...text]
  chars.forEach((c, i) => {
    const a = (i / chars.length) * Math.PI * 2 - Math.PI / 2
    ctx.save()
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(c, 0, -r * 0.83)
    ctx.restore()
  })
  ctx.font = `500 ${Math.round(r * 0.5)}px ${NUM}`
  ctx.fillText(value, 0, -r * 0.08)
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(-r * 0.24, r * 0.22)
  ctx.lineTo(r * 0.24, r * 0.22)
  ctx.stroke()
  ctx.font = `${Math.round(r * 0.13)}px ${NUM}`
  ctx.fillText([...unit].join(' '), 0, r * 0.38)
  ctx.restore()
}

/** 朱砂方印「迹」 */
function seal(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save()
  roundRectPath(ctx, x, y, size, size, size * 0.16)
  ctx.fillStyle = color
  ctx.fill()
  roundRectPath(ctx, x + 5, y + 5, size - 10, size - 10, size * 0.12)
  ctx.strokeStyle = 'rgba(255,253,249,0.4)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = WHITE
  ctx.font = `600 ${Math.round(size * 0.6)}px ${SERIF}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('迹', x + size / 2, y + size / 2 + size * 0.03)
  ctx.restore()
}

/** 路线示意：经度按平均纬度压缩后等比缩放到框内；朱砂实线 + 纸色圆点、墨色描边 */
function drawRoute(
  ctx: CanvasRenderingContext2D,
  path: LngLat[],
  dots: { lng: number; lat: number; color: string }[],
  box: { x: number; y: number; w: number; h: number },
  accent: string,
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
  const pad = 40
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
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = accent
    ctx.lineWidth = 5
    ctx.beginPath()
    path.forEach((p, i) => {
      const [x, y] = at(p)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }
  dots.forEach((d, i) => {
    const [x, y] = at([d.lng, d.lat])
    ctx.beginPath()
    ctx.arc(x, y, 10, 0, Math.PI * 2)
    ctx.fillStyle = i === 0 ? INK : PAPER
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = INK
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fillStyle = i === 0 ? PAPER : d.color
    ctx.fill()
  })
}

/** 画海报，返回 JPEG 的 data URL（微信里长按保存不支持 blob: 链接） */
export async function drawPoster(o: PosterOptions): Promise<string> {
  const theme = THEMES[o.theme]
  const statText = o.stats.map((s) => s.label + (s.unit ?? '')).join('')
  await ensureFonts([
    [`600 68px ${SERIF}`, o.title + (o.lead ?? '') + '迹旅行手账' + statText],
    [`italic 500 44px ${NUM}`, o.siteName + 'TripHub'],
    [`500 72px ${NUM}`, '0123456789.,-TRAVELJOURNAYSDKM·'],
  ])
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('海报生成失败')
  try {
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, W, H)
    grain(ctx)
    const CW = W - 2 * M

    // 报头：站名 + 右侧小字，下接上粗下细的双线
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = INK
    ctx.font = `italic 500 46px ${NUM}`
    const nameW = ctx.measureText(o.siteName).width
    ctx.fillText(wrap(ctx, o.siteName, CW * 0.55, 1)[0], M, 128)
    ctx.fillStyle = INK4
    ctx.font = `600 22px ${SERIF}`
    spaced(ctx, '旅行手账', M + Math.min(nameW, CW * 0.55) + 20, 124, 8)
    ctx.font = `500 20px ${NUM}`
    spaced(ctx, 'TRAVEL JOURNAL', W - M, 124, 5, 'right')
    hairline(ctx, M, 152, W - M, 152, INK, 4)
    hairline(ctx, M, 162, W - M, 162, INK, 1.5)

    // 封面：照片（细边框）或矿物色块 + 宋体大字 + 邮戳
    const hasRoute = o.path.length > 0 || (o.dots?.length ?? 0) > 0
    // 没有路线时数据栏只有一行，多出的高度给封面
    const cover = { x: M, y: 196, w: CW, h: hasRoute ? 480 : 600 }
    let drawn = false
    if (o.coverUrl) {
      try {
        const img = await loadImg(o.coverUrl, true)
        ctx.save()
        roundRectPath(ctx, cover.x, cover.y, cover.w, cover.h, 10)
        ctx.clip()
        drawCover(ctx, img, cover.x, cover.y, cover.w, cover.h)
        ctx.restore()
        drawn = true
      } catch {
        /* 跳过封面，用色块 */
      }
    }
    if (!drawn) {
      const m = mineralOf(o.seed ?? [...o.title].reduce((a, c) => a + c.charCodeAt(0), 0))
      ctx.save()
      roundRectPath(ctx, cover.x, cover.y, cover.w, cover.h, 10)
      ctx.fillStyle = m.bg
      ctx.fill()
      ctx.clip()
      grain(ctx)
      ctx.restore()
      ctx.fillStyle = m.fg
      const lead = o.lead || o.siteName
      const size = [...lead].length <= 2 ? 170 : [...lead].length <= 4 ? 130 : 96
      ctx.font = `600 ${size}px ${SERIF}`
      ctx.fillText(wrap(ctx, lead, cover.w - 120, 1)[0], cover.x + 60, cover.y + cover.h - 110)
      hairline(ctx, cover.x + 62, cover.y + cover.h - 64, cover.x + 132, cover.y + cover.h - 64, m.fg, 2)
      ctx.font = `24px ${SANS}`
      spaced(ctx, theme.tagline, cover.x + 152, cover.y + cover.h - 55, 4)
      if (o.stamp)
        postmark(ctx, cover.x + cover.w - 150, cover.y + 150, 104, m.fg === INK ? theme.accent : m.stamp, o.stamp.value, o.stamp.unit, `${o.siteName} · Travel Journal · `)
    }
    ctx.save()
    roundRectPath(ctx, cover.x, cover.y, cover.w, cover.h, 10)
    ctx.strokeStyle = 'rgba(27,26,23,0.14)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()

    // 标题与副标题
    let y = cover.y + cover.h + 96
    ctx.fillStyle = INK
    ctx.font = `600 64px ${SERIF}`
    for (const line of wrap(ctx, o.title, CW, 2)) {
      ctx.fillText(line, M, y)
      y += 86
    }
    y -= 30
    if (o.subtitle) {
      ctx.fillStyle = INK5
      ctx.font = `28px ${SANS}`
      ctx.fillText(wrap(ctx, o.subtitle, CW, 1)[0], M, y + 20)
      y += 40
    }

    // 数据栏：左侧 2×2 数字，右侧路线示意；没有路线时四个数字一行
    const panelY = y + 44
    const panelH = 300
    hairline(ctx, M, panelY, W - M, panelY, INK, 2)
    const statsW = hasRoute ? 440 : CW
    const cols = hasRoute ? 2 : Math.max(1, o.stats.length)
    const rows = Math.ceil(o.stats.length / cols)
    const cellW = statsW / cols
    const cellH = hasRoute ? panelH / rows : 170
    o.stats.forEach((st, i) => {
      const c = i % cols
      const r = Math.floor(i / cols)
      const sx = M + c * cellW + (c ? 28 : 0)
      const sy = panelY + r * cellH
      if (c) hairline(ctx, M + c * cellW, sy + 24, M + c * cellW, sy + cellH - 20)
      if (r) hairline(ctx, M, sy, M + statsW, sy)
      ctx.fillStyle = INK4
      ctx.font = `600 22px ${SERIF}`
      spaced(ctx, st.label, sx, sy + 50, 6)
      const unit = st.unit ? ` ${st.unit}` : ''
      let size = 76
      const fits = () => {
        ctx.font = `24px ${SANS}`
        const uw = ctx.measureText(unit).width
        ctx.font = `500 ${size}px ${NUM}`
        return ctx.measureText(st.value).width + uw <= cellW - 40
      }
      while (size > 36 && !fits()) size -= 4
      ctx.fillStyle = INK
      ctx.font = `500 ${size}px ${NUM}`
      const vw = ctx.measureText(st.value).width
      ctx.fillText(st.value, sx, sy + 128)
      if (unit) {
        ctx.fillStyle = INK4
        ctx.font = `24px ${SANS}`
        ctx.fillText(unit, sx + vw + 2, sy + 128)
      }
    })
    if (hasRoute) {
      const box = { x: M + statsW + 32, y: panelY + 24, w: CW - statsW - 32, h: panelH - 24 }
      hairline(ctx, box.x - 16, panelY + 24, box.x - 16, panelY + panelH - 20)
      // 极淡的经纬网
      ctx.save()
      ctx.setLineDash([3, 9])
      for (let gx = 1; gx < 4; gx++) hairline(ctx, box.x + (box.w * gx) / 4, box.y, box.x + (box.w * gx) / 4, box.y + box.h, 'rgba(27,26,23,0.12)', 1.5)
      for (let gy = 1; gy < 3; gy++) hairline(ctx, box.x, box.y + (box.h * gy) / 3, box.x + box.w, box.y + (box.h * gy) / 3, 'rgba(27,26,23,0.12)', 1.5)
      ctx.restore()
      drawRoute(ctx, o.path, o.dots ?? [], box, theme.accent)
      ctx.fillStyle = INK4
      ctx.font = `italic 20px ${NUM}`
      ctx.fillText('Route', box.x, box.y + box.h - 4)
    }

    // 页脚：印章 + 站名 + 一句话；右侧二维码
    const qs = 168
    const qy = H - M - qs - 30
    hairline(ctx, M, qy - 36, W - M, qy - 36, LINE, 2)
    seal(ctx, M, qy + 32, 92, theme.accent)
    const textW = CW - 120 - (o.qrUrl ? qs + 40 : 0)
    ctx.fillStyle = INK
    ctx.font = `italic 500 44px ${NUM}`
    ctx.fillText(wrap(ctx, o.siteName, textW, 1)[0], M + 120, qy + 80)
    ctx.fillStyle = INK5
    ctx.font = `26px ${SANS}`
    ctx.fillText(wrap(ctx, o.qrUrl ? '扫码查看完整路线和打卡点评' : theme.tagline, textW, 1)[0], M + 120, qy + 124)
    if (o.qrUrl) {
      const qr = await loadImg(await QRCode.toDataURL(o.qrUrl, { margin: 1, width: 260, color: { dark: INK, light: WHITE } }))
      const qx = W - M - qs
      ctx.fillStyle = WHITE
      ctx.fillRect(qx - 10, qy - 10, qs + 20, qs + 20)
      ctx.strokeStyle = LINE
      ctx.lineWidth = 2
      ctx.strokeRect(qx - 10, qy - 10, qs + 20, qs + 20)
      ctx.drawImage(qr, qx, qy, qs, qs)
      ctx.fillStyle = INK4
      ctx.font = `20px ${SANS}`
      ctx.textAlign = 'center'
      ctx.fillText('长按识别二维码', qx + qs / 2, qy + qs + 42)
      ctx.textAlign = 'left'
    }

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
        <p className="py-12 text-center text-sm text-brand-600">{error}</p>
      ) : !url ? (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-ink-400">
          <Spinner className="size-7" />
          正在生成海报…
        </div>
      ) : (
        <div className="space-y-3">
          <img src={url} alt="分享海报" className="mx-auto max-h-[60dvh] w-auto rounded-md shadow-card" />
          <p className="text-center text-xs tracking-wide text-ink-400">长按图片保存，发朋友圈 / 小红书</p>
          <div className="flex justify-center gap-2">
            <a href={url} download={filename} className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <Download className="size-4" strokeWidth={1.75} />
              保存图片
            </a>
            {file && (
              <Button size="sm" icon={<Share2 className="size-4" strokeWidth={1.75} />} onClick={share}>
                分享图片
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
