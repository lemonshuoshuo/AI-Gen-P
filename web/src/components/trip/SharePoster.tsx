// 旅程分享海报：朋友圈、小红书以图片为主（小红书不能发链接），在浏览器里用 canvas 画一张竖图
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
// 海报的数字用 Cormorant 的等高数字：画布不能设置 font-variant-numeric，改为注册一个默认开启 lnum 的字体别名
import cormorantLatin from '@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2?url'
import { Download, Share2 } from 'lucide-react'
import { Button, Modal, Spinner, buttonClass } from '@/components/ui'

type LngLat = [number, number]

export interface PosterOptions {
  title: string
  subtitle?: string
  /** unit 用小一号的字写在数字后面（如「12.3」「公里」） */
  stats: { label: string; value: string; unit?: string }[]
  coverUrl?: string
  /** 没有封面照片时，首屏上的超大宋体字（通常是第一个城市） */
  lead?: string
  /** 保留字段（旧版按它选封面底色）；现在没有照片时统一是近黑底排版封面 */
  seed?: number
  /** 无封面时右上角的细线邮戳（如天数） */
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
// 「夜航」：近黑底、象牙白字、极细分隔线；朱砂（情侣空间用胭脂）只是字标旁一个小圆点
const BG = '#0b0b0a'
const SURFACE = '#121211'
const IVORY = '#f2eee6'
const INK5 = '#948e84'
const LINE = '#2a2926'
const SANS = '"Manrope Variable",-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const SERIF = '"Cormorant Garamond Variable","Noto Serif SC","Songti SC","STSong",serif'
const NUM_FAMILY = 'TripHub Poster Numerals'
const NUM = `"${NUM_FAMILY}","Cormorant Garamond Variable",Georgia,"Noto Serif SC",serif`
const THEMES = {
  brand: { accent: '#cf6041', tagline: '记录旅程 · 分享路线 · 打卡避雷' },
  love: { accent: '#bc7889', tagline: '我们一起走过的地方' },
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

let numFont: Promise<void> | null = null
/** 注册等高数字字体（FontFace 的 featureSettings 不支持时退回普通的 Cormorant，数字是旧式的） */
function ensureNumFont() {
  numFont ??= (async () => {
    try {
      const face = new FontFace(NUM_FAMILY, `url(${cormorantLatin})`, { weight: '300 700', featureSettings: '"lnum" 1' })
      document.fonts.add(await face.load())
    } catch {
      /* 用普通的 Cormorant */
    }
  })()
  return numFont
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

function hairline(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color = LINE, width = 1.5) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

/** 胶片颗粒：极淡的亮色噪点，小图块平铺，避免大面积纯黑死板 */
function grain(ctx: CanvasRenderingContext2D) {
  const tile = document.createElement('canvas')
  try {
    tile.width = tile.height = 128
    const t = tile.getContext('2d')
    if (!t) return
    const img = t.createImageData(128, 128)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255
      img.data[i + 1] = 248
      img.data[i + 2] = 235
      img.data[i + 3] = Math.random() < 0.5 ? Math.floor(Math.random() * 9) : 0
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

/** 细线邮戳：双圈 + 沿圈小字 + 中间细字大数字 */
function postmark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, value: string, unit: string, ring: string) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((-8 * Math.PI) / 180)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2)
  ctx.stroke()
  // 沿圈的字：重复到约一整圈的长度，再均匀排开
  ctx.font = `500 ${Math.round(r * 0.12)}px ${SANS}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const circ = 2 * Math.PI * r * 0.83
  const unitText = ring.toUpperCase()
  let text = unitText
  while (ctx.measureText(text + unitText).width + (text.length + unitText.length) * r * 0.06 < circ) text += unitText
  const chars = [...text]
  chars.forEach((c, i) => {
    const a = (i / chars.length) * Math.PI * 2 - Math.PI / 2
    ctx.save()
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(c, 0, -r * 0.83)
    ctx.restore()
  })
  ctx.font = `300 ${Math.round(r * 0.52)}px ${NUM}`
  ctx.fillText(value, 0, -r * 0.08)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(-r * 0.2, r * 0.22)
  ctx.lineTo(r * 0.2, r * 0.22)
  ctx.stroke()
  ctx.font = `500 ${Math.round(r * 0.1)}px ${SANS}`
  ctx.fillText([...unit].join(' '), 0, r * 0.38)
  ctx.restore()
}

/** 路线示意：经度按平均纬度压缩后等比缩放到框内；象牙白细线 + 空心圆点，起点实心 */
function drawRoute(ctx: CanvasRenderingContext2D, path: LngLat[], dots: { lng: number; lat: number; color: string }[], box: { x: number; y: number; w: number; h: number }) {
  const all: LngLat[] = [...path, ...dots.map((d) => [d.lng, d.lat] as LngLat)]
  if (!all.length) return
  const k = Math.cos((all.reduce((a, p) => a + p[1], 0) / all.length) * (Math.PI / 180))
  const xs = all.map((p) => p[0] * k)
  const ys = all.map((p) => -p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const pad = 36
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
    ctx.strokeStyle = IVORY
    ctx.lineWidth = 2.5
    ctx.beginPath()
    path.forEach((p, i) => {
      const [x, y] = at(p)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    ctx.restore()
  }
  // 相距不到 12px 的点合成一个标记（如环线的起终点、在同一处连打两次卡），不画两个错开的圆；
  // 起点所在的一组画成「圈里一点」
  const groups: { x: number; y: number; start: boolean; n: number }[] = []
  dots.forEach((d, i) => {
    const [x, y] = at([d.lng, d.lat])
    const g = groups.find((g) => Math.hypot(g.x - x, g.y - y) < 12)
    if (g) g.n++
    else groups.push({ x, y, start: i === 0, n: 1 })
  })
  const ring = (x: number, y: number, r: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = IVORY
    ctx.stroke()
  }
  groups
    .slice()
    .sort((a, b) => Number(a.start) - Number(b.start))
    .forEach((g) => {
      if (!g.start) return ring(g.x, g.y, g.n > 1 ? 9 : 7, BG)
      if (g.n === 1) return ring(g.x, g.y, 9, IVORY)
      ring(g.x, g.y, 13, BG)
      ctx.beginPath()
      ctx.arc(g.x, g.y, 6, 0, Math.PI * 2)
      ctx.fillStyle = IVORY
      ctx.fill()
    })
}

/** 画海报，返回 JPEG 的 data URL（微信里长按保存不支持 blob: 链接） */
export async function drawPoster(o: PosterOptions): Promise<string> {
  const theme = THEMES[o.theme]
  const statText = o.stats.map((s) => s.label + (s.unit ?? '')).join('')
  await Promise.race([ensureNumFont(), new Promise((r) => setTimeout(r, 3000))])
  await ensureFonts([
    [`400 84px ${SERIF}`, o.title + (o.lead ?? '') + statText],
    [`400 60px ${SERIF}`, o.siteName + 'TripHub'],
    [`300 100px ${NUM}`, '0123456789.,-—' + o.stats.map((s) => s.value).join('')],
    [`500 20px ${SANS}`, 'TRAVELJOURNAYSDKMROUTE·' + (o.subtitle ?? '') + theme.tagline],
  ])
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('海报生成失败')
  try {
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, W, H)
    const CW = W - 2 * M
    ctx.textBaseline = 'alphabetic'

    // 首屏：整幅出血的封面照片，底部渐隐到近黑；没有照片时是近黑底上的超大宋体地名 + 细线邮戳
    const coverH = 900
    let drawn = false
    if (o.coverUrl) {
      try {
        const img = await loadImg(o.coverUrl, true)
        drawCover(ctx, img, 0, 0, W, coverH)
        // 极淡的整体压暗 + 顶部与底部渐变：保证白字对比度，照片仍是主角
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        ctx.fillRect(0, 0, W, coverH)
        const top = ctx.createLinearGradient(0, 0, 0, 260)
        top.addColorStop(0, 'rgba(0,0,0,0.55)')
        top.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = top
        ctx.fillRect(0, 0, W, 260)
        const fade = ctx.createLinearGradient(0, coverH * 0.42, 0, coverH)
        fade.addColorStop(0, 'rgba(11,11,10,0)')
        fade.addColorStop(0.7, 'rgba(11,11,10,0.78)')
        fade.addColorStop(1, BG)
        ctx.fillStyle = fade
        ctx.fillRect(0, coverH * 0.42 - 1, W, coverH * 0.58 + 2)
        drawn = true
      } catch {
        /* 跳过封面，用排版封面 */
      }
    }
    if (!drawn) {
      ctx.fillStyle = SURFACE
      ctx.fillRect(0, 0, W, coverH - 150)
      const fade = ctx.createLinearGradient(0, coverH - 400, 0, coverH - 150)
      fade.addColorStop(0, 'rgba(11,11,10,0)')
      fade.addColorStop(1, BG)
      ctx.fillStyle = fade
      ctx.fillRect(0, coverH - 400, W, 251)
      // 极淡的经纬网
      ctx.save()
      ctx.setLineDash([2, 10])
      for (let gx = 1; gx < 4; gx++) hairline(ctx, (W * gx) / 4, 190, (W * gx) / 4, coverH - 180, 'rgba(242,238,230,0.07)', 1)
      ctx.restore()
      const lead = o.lead || o.siteName
      const n = [...lead].length
      const size = n <= 2 ? 330 : n <= 3 ? 250 : n <= 4 ? 196 : 130
      ctx.fillStyle = IVORY
      ctx.font = `400 ${size}px ${SERIF}`
      ctx.fillText(wrap(ctx, lead, CW, 1)[0], M - size * 0.04, 640)
      if (o.stamp) postmark(ctx, W - M - 118, 320, 118, INK5, o.stamp.value, o.stamp.unit, `${o.siteName} · Travel Journal · `)
    }
    grain(ctx)

    // 报头：字标 + 小圆点，右侧小字
    ctx.fillStyle = drawn ? '#ffffff' : IVORY
    ctx.font = `400 50px ${SERIF}`
    const name = wrap(ctx, o.siteName, CW * 0.55, 1)[0]
    ctx.fillText(name, M, 120)
    const nameW = ctx.measureText(name).width
    ctx.beginPath()
    ctx.arc(M + nameW + 16, 106, 5, 0, Math.PI * 2)
    ctx.fillStyle = theme.accent
    ctx.fill()
    ctx.fillStyle = drawn ? 'rgba(255,255,255,0.72)' : INK5
    ctx.font = `500 18px ${SANS}`
    spaced(ctx, 'TRAVEL JOURNAL', W - M, 116, 5, 'right')

    // 标题：超大宋体，最后一行压在照片渐隐处
    ctx.font = `400 84px ${SERIF}`
    const lines = wrap(ctx, o.title, CW, 2)
    let y = 880 - (lines.length - 1) * 104
    ctx.fillStyle = drawn ? '#ffffff' : IVORY
    for (const line of lines) {
      ctx.fillText(line, M - 4, y)
      y += 104
    }
    if (o.subtitle) {
      ctx.fillStyle = INK5
      ctx.font = `400 26px ${SANS}`
      ctx.fillText(wrap(ctx, o.subtitle, CW, 1)[0], M, 950)
    }

    // 数据栏：左侧 2×2 细字大数字，右侧路线示意；没有路线时四个数字一行
    const hasRoute = o.path.length > 0 || (o.dots?.length ?? 0) > 0
    const panelY = 1010
    const panelH = 330
    hairline(ctx, M, panelY, W - M, panelY)
    const statsW = hasRoute ? 470 : CW
    const cols = hasRoute ? 2 : Math.max(1, o.stats.length)
    const rows = Math.ceil(o.stats.length / cols)
    const cellW = statsW / cols
    const cellH = hasRoute ? panelH / rows : 200
    o.stats.forEach((st, i) => {
      const c = i % cols
      const r = Math.floor(i / cols)
      const sx = M + c * cellW + (c ? 28 : 0)
      const sy = panelY + r * cellH
      if (c) hairline(ctx, M + c * cellW, sy + 26, M + c * cellW, sy + cellH - 22)
      if (r) hairline(ctx, M, sy, M + statsW, sy)
      ctx.fillStyle = INK5
      ctx.font = `500 20px ${SANS}`
      spaced(ctx, st.label, sx, sy + 54, 6)
      const unit = st.unit ? ` ${st.unit}` : ''
      let size = 96
      const fits = () => {
        ctx.font = `400 22px ${SANS}`
        const uw = ctx.measureText(unit).width
        ctx.font = `300 ${size}px ${NUM}`
        return ctx.measureText(st.value).width + uw <= cellW - 44
      }
      while (size > 40 && !fits()) size -= 4
      ctx.fillStyle = IVORY
      ctx.font = `300 ${size}px ${NUM}`
      const vw = ctx.measureText(st.value).width
      ctx.fillText(st.value, sx - 2, sy + 142)
      if (unit) {
        ctx.fillStyle = INK5
        ctx.font = `400 22px ${SANS}`
        ctx.fillText(unit, sx + vw + 4, sy + 142)
      }
    })
    if (hasRoute) {
      const box = { x: M + statsW + 40, y: panelY + 26, w: CW - statsW - 40, h: panelH - 26 }
      hairline(ctx, box.x - 20, panelY + 26, box.x - 20, panelY + panelH - 22)
      // 极淡的经纬网
      ctx.save()
      ctx.setLineDash([2, 9])
      for (let gx = 1; gx < 4; gx++) hairline(ctx, box.x + (box.w * gx) / 4, box.y, box.x + (box.w * gx) / 4, box.y + box.h, 'rgba(242,238,230,0.1)', 1)
      for (let gy = 1; gy < 3; gy++) hairline(ctx, box.x, box.y + (box.h * gy) / 3, box.x + box.w, box.y + (box.h * gy) / 3, 'rgba(242,238,230,0.1)', 1)
      ctx.restore()
      drawRoute(ctx, o.path, o.dots ?? [], box)
      ctx.fillStyle = INK5
      ctx.font = `500 16px ${SANS}`
      spaced(ctx, 'ROUTE', box.x, box.y + 28, 4)
    }

    // 页脚：细线 + 字标与一句话；右侧象牙白底的二维码
    const fy = 1390
    hairline(ctx, M, fy, W - M, fy)
    const qs = 150
    const textW = CW - (o.qrUrl ? qs + 60 : 0)
    ctx.fillStyle = IVORY
    ctx.font = `400 26px ${SANS}`
    ctx.fillText(wrap(ctx, o.qrUrl ? '扫码查看完整路线和打卡点评' : theme.tagline, textW, 1)[0], M, fy + 66)
    ctx.fillStyle = INK5
    ctx.font = `400 22px ${SANS}`
    ctx.fillText(wrap(ctx, o.qrUrl ? theme.tagline : o.siteName, textW, 1)[0], M, fy + 104)
    if (o.qrUrl) {
      const qr = await loadImg(await QRCode.toDataURL(o.qrUrl, { margin: 1, width: 260, color: { dark: BG, light: IVORY } }))
      const qx = W - M - qs
      const qy = fy + 34
      ctx.fillStyle = IVORY
      ctx.fillRect(qx - 8, qy - 8, qs + 16, qs + 16)
      ctx.drawImage(qr, qx, qy, qs, qs)
    }

    return canvas.toDataURL('image/jpeg', 0.92)
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
          <img src={url} alt="分享海报" className="mx-auto max-h-[60dvh] w-auto rounded-sm ring-1 ring-ink-200" />
          <p className="caption text-center">长按图片保存，发朋友圈 / 小红书</p>
          <div className="flex justify-center gap-2 pt-1">
            <a href={url} download={filename} className={buttonClass({ variant: 'outline' })}>
              <Download className="size-4" strokeWidth={1.5} />
              保存图片
            </a>
            {file && (
              <Button icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={share}>
                分享图片
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
