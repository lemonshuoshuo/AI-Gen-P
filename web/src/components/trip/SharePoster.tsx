// 旅程分享海报：朋友圈、小红书以图片为主（小红书不能发链接），在浏览器里用 canvas 画一张竖图
// 配色与字体跟随当前主题和深浅色（手帐是米白纸 + 砖红、夜航是近黑 + 象牙白…）
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
// 海报的数字用各主题的数字字体：画布不能设置 font-variant-numeric，改为注册一个默认开启 lnum / tnum 的字体别名
import cormorantLatin from '@fontsource-variable/cormorant-garamond/files/cormorant-garamond-latin-wght-normal.woff2?url'
import frauncesLatin from '@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2?url'
import bricolageLatin from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2?url'
import instrumentSerifLatin from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2?url'
import newsreaderLatin from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url'
import { Download, Share2 } from 'lucide-react'
import { Button, Modal, Spinner, buttonClass } from '@/components/ui'
import { ensureThemeFonts, getResolvedTheme } from '@/theme/runtime'
import type { ThemeId } from '@/theme/themes'

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
const THEMES = {
  brand: { tagline: '记录旅程 · 分享路线 · 打卡避雷' },
  love: { tagline: '我们一起走过的地方' },
}

/** 海报用到的颜色与字体：取自当前主题（页面底色、主文字、次要文字、细线、强调色） */
interface Palette {
  bg: string
  surface: string
  ink: string
  muted: string
  line: string
  /** 字标旁的小圆点：强调色（情侣空间用胭脂） */
  accent: string
  love: string
  dark: boolean
  sans: string
  serif: string
  num: string
  displayWeight: number
  numWeight: number
}

// 没读到主题变量时（不应发生）退回原来的「夜航」
const FALLBACK: Palette = {
  bg: '#0b0b0a',
  surface: '#121211',
  ink: '#f2eee6',
  muted: '#948e84',
  line: '#2a2926',
  accent: '#cf6041',
  love: '#bc7889',
  dark: true,
  sans: '"Manrope Variable",-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif',
  serif: '"Cormorant Garamond Variable","Noto Serif SC","Songti SC","STSong",serif',
  num: '"Cormorant Garamond Variable",Georgia,"Noto Serif SC",serif',
  displayWeight: 400,
  numWeight: 300,
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb
  const n = (name: string, fb: number) => Number(cs.getPropertyValue(name).trim()) || fb
  return {
    bg: v('--color-paper', FALLBACK.bg),
    surface: v('--color-surface', FALLBACK.surface),
    ink: v('--color-ink-900', FALLBACK.ink),
    muted: v('--color-ink-500', FALLBACK.muted),
    line: v('--color-line', FALLBACK.line),
    accent: v('--color-brand-600', FALLBACK.accent),
    love: v('--color-pink-600', FALLBACK.love),
    dark: getResolvedTheme().mode === 'dark',
    sans: v('--font-sans', FALLBACK.sans),
    serif: v('--font-display', FALLBACK.serif),
    num: v('--font-num', FALLBACK.num),
    displayWeight: n('--display-weight', FALLBACK.displayWeight),
    numWeight: n('--num-weight', FALLBACK.numWeight),
  }
}

/** 任意 CSS 颜色 → [r, g, b]（借画布解析） */
function toRgb(color: string): [number, number, number] {
  const c = document.createElement('canvas').getContext('2d')
  if (!c) return [0, 0, 0]
  c.fillStyle = '#000'
  c.fillStyle = color
  const s = String(c.fillStyle)
  if (s.startsWith('#')) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
  const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
  return [m[0], m[1], m[2]]
}
const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

// 各主题数字字体的西文切片与字重范围
const NUM_FONTS: Record<ThemeId, { url: string; weight: string }> = {
  journal: { url: frauncesLatin, weight: '100 900' },
  camp: { url: bricolageLatin, weight: '200 800' },
  coast: { url: instrumentSerifLatin, weight: '400' },
  dusk: { url: newsreaderLatin, weight: '100 900' },
  voyage: { url: cormorantLatin, weight: '300 700' },
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

const numFonts = new Map<ThemeId, Promise<void>>()
const numFamily = (theme: ThemeId) => `TripHub Poster Numerals ${theme}`
/** 注册等高数字字体（FontFace 的 featureSettings 不支持时退回主题的数字字体本身） */
function ensureNumFont(theme: ThemeId) {
  let job = numFonts.get(theme)
  if (!job) {
    job = (async () => {
      try {
        const f = NUM_FONTS[theme]
        const face = new FontFace(numFamily(theme), `url(${f.url})`, { weight: f.weight, featureSettings: '"lnum" 1, "tnum" 1' })
        document.fonts.add(await face.load())
      } catch {
        /* 用主题的数字字体 */
      }
    })()
    numFonts.set(theme, job)
  }
  return job
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

function hairline(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1.5) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

/** 纸纹 / 胶片颗粒：极淡的噪点（深色海报用亮点、浅色海报用墨点），小图块平铺，避免大面积纯色死板 */
function grain(ctx: CanvasRenderingContext2D, speck: [number, number, number]) {
  const tile = document.createElement('canvas')
  try {
    tile.width = tile.height = 128
    const t = tile.getContext('2d')
    if (!t) return
    const img = t.createImageData(128, 128)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = speck[0]
      img.data[i + 1] = speck[1]
      img.data[i + 2] = speck[2]
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
function postmark(ctx: CanvasRenderingContext2D, p: Palette, NUM: string, cx: number, cy: number, r: number, color: string, value: string, unit: string, ring: string) {
  const SANS = p.sans
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
  ctx.font = `${p.numWeight} ${Math.round(r * 0.52)}px ${NUM}`
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

/** 路线示意：经度按平均纬度压缩后等比缩放到框内；主文字色细线 + 空心圆点，起点实心 */
function drawRoute(ctx: CanvasRenderingContext2D, pal: Palette, path: LngLat[], dots: { lng: number; lat: number; color: string }[], box: { x: number; y: number; w: number; h: number }) {
  const INK = pal.ink
  const BG = pal.bg
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
    ctx.strokeStyle = INK
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
    ctx.strokeStyle = INK
    ctx.stroke()
  }
  groups
    .slice()
    .sort((a, b) => Number(a.start) - Number(b.start))
    .forEach((g) => {
      if (!g.start) return ring(g.x, g.y, g.n > 1 ? 9 : 7, BG)
      if (g.n === 1) return ring(g.x, g.y, 9, INK)
      ring(g.x, g.y, 13, BG)
      ctx.beginPath()
      ctx.arc(g.x, g.y, 6, 0, Math.PI * 2)
      ctx.fillStyle = INK
      ctx.fill()
    })
}

/** 画海报，返回 JPEG 的 data URL（微信里长按保存不支持 blob: 链接） */
export async function drawPoster(o: PosterOptions): Promise<string> {
  const theme = THEMES[o.theme]
  const siteTheme = getResolvedTheme().theme
  const P = readPalette()
  const { bg: BG, surface: SURFACE, ink: INK, muted: INK5, line: LINE, sans: SANS, serif: SERIF } = P
  const NUM = `"${numFamily(siteTheme)}",${P.num}`
  const DW = P.displayWeight
  const NW = P.numWeight
  const accent = o.theme === 'love' ? P.love : P.accent
  const bgRgb = toRgb(BG)
  const inkRgb = toRgb(INK)
  const statText = o.stats.map((s) => s.label + (s.unit ?? '')).join('')
  await Promise.race([Promise.all([ensureThemeFonts(siteTheme), ensureNumFont(siteTheme)]), new Promise((r) => setTimeout(r, 3000))])
  await ensureFonts([
    [`${DW} 84px ${SERIF}`, o.title + (o.lead ?? '') + statText],
    [`${DW} 60px ${SERIF}`, o.siteName + 'TripHub'],
    [`${NW} 100px ${NUM}`, '0123456789.,-—' + o.stats.map((s) => s.value).join('')],
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

    // 首屏：整幅出血的封面照片，底部渐隐到页面底色；没有照片时是底色上的超大标题字地名 + 细线邮戳
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
        fade.addColorStop(0, rgba(bgRgb, 0))
        fade.addColorStop(0.7, rgba(bgRgb, 0.8))
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
      fade.addColorStop(0, rgba(bgRgb, 0))
      fade.addColorStop(1, BG)
      ctx.fillStyle = fade
      ctx.fillRect(0, coverH - 400, W, 251)
      // 极淡的经纬网
      ctx.save()
      ctx.setLineDash([2, 10])
      for (let gx = 1; gx < 4; gx++) hairline(ctx, (W * gx) / 4, 190, (W * gx) / 4, coverH - 180, rgba(inkRgb, 0.08), 1)
      ctx.restore()
      const lead = o.lead || o.siteName
      const n = [...lead].length
      const size = n <= 2 ? 330 : n <= 3 ? 250 : n <= 4 ? 196 : 130
      ctx.fillStyle = INK
      ctx.font = `${DW} ${size}px ${SERIF}`
      ctx.fillText(wrap(ctx, lead, CW, 1)[0], M - size * 0.04, 640)
      if (o.stamp) postmark(ctx, P, NUM, W - M - 118, 320, 118, INK5, o.stamp.value, o.stamp.unit, `${o.siteName} · Travel Journal · `)
    }
    grain(ctx, P.dark ? [255, 248, 235] : inkRgb)

    // 报头：字标 + 小圆点，右侧小字
    ctx.fillStyle = drawn ? '#ffffff' : INK
    ctx.font = `${DW} 50px ${SERIF}`
    const name = wrap(ctx, o.siteName, CW * 0.55, 1)[0]
    ctx.fillText(name, M, 120)
    const nameW = ctx.measureText(name).width
    ctx.beginPath()
    ctx.arc(M + nameW + 16, 106, 5, 0, Math.PI * 2)
    ctx.fillStyle = accent
    ctx.fill()
    ctx.fillStyle = drawn ? 'rgba(255,255,255,0.72)' : INK5
    ctx.font = `500 18px ${SANS}`
    spaced(ctx, 'TRAVEL JOURNAL', W - M, 116, 5, 'right')

    // 标题：主题的标题字体，最后一行压在照片渐隐处（渐隐到页面底色，所以用主文字色）
    ctx.font = `${DW} 84px ${SERIF}`
    const lines = wrap(ctx, o.title, CW, 2)
    let y = 880 - (lines.length - 1) * 104
    ctx.fillStyle = INK
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
    hairline(ctx, M, panelY, W - M, panelY, LINE)
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
      if (c) hairline(ctx, M + c * cellW, sy + 26, M + c * cellW, sy + cellH - 22, LINE)
      if (r) hairline(ctx, M, sy, M + statsW, sy, LINE)
      ctx.fillStyle = INK5
      ctx.font = `500 20px ${SANS}`
      spaced(ctx, st.label, sx, sy + 54, 6)
      const unit = st.unit ? ` ${st.unit}` : ''
      let size = 96
      const fits = () => {
        ctx.font = `400 22px ${SANS}`
        const uw = ctx.measureText(unit).width
        ctx.font = `${NW} ${size}px ${NUM}`
        return ctx.measureText(st.value).width + uw <= cellW - 44
      }
      while (size > 40 && !fits()) size -= 4
      ctx.fillStyle = INK
      ctx.font = `${NW} ${size}px ${NUM}`
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
      hairline(ctx, box.x - 20, panelY + 26, box.x - 20, panelY + panelH - 22, LINE)
      // 极淡的经纬网
      ctx.save()
      ctx.setLineDash([2, 9])
      for (let gx = 1; gx < 4; gx++) hairline(ctx, box.x + (box.w * gx) / 4, box.y, box.x + (box.w * gx) / 4, box.y + box.h, rgba(inkRgb, 0.11), 1)
      for (let gy = 1; gy < 3; gy++) hairline(ctx, box.x, box.y + (box.h * gy) / 3, box.x + box.w, box.y + (box.h * gy) / 3, rgba(inkRgb, 0.11), 1)
      ctx.restore()
      drawRoute(ctx, P, o.path, o.dots ?? [], box)
      ctx.fillStyle = INK5
      ctx.font = `500 16px ${SANS}`
      spaced(ctx, 'ROUTE', box.x, box.y + 28, 4)
    }

    // 页脚：细线 + 字标与一句话；右侧浅底深码的二维码
    const fy = 1390
    hairline(ctx, M, fy, W - M, fy, LINE)
    const qs = 150
    const textW = CW - (o.qrUrl ? qs + 60 : 0)
    ctx.fillStyle = INK
    ctx.font = `400 26px ${SANS}`
    ctx.fillText(wrap(ctx, o.qrUrl ? '扫码查看完整路线和打卡点评' : theme.tagline, textW, 1)[0], M, fy + 66)
    ctx.fillStyle = INK5
    ctx.font = `400 22px ${SANS}`
    ctx.fillText(wrap(ctx, o.qrUrl ? theme.tagline : o.siteName, textW, 1)[0], M, fy + 104)
    if (o.qrUrl) {
      // 二维码永远是浅底深码：深色海报用「底色码 + 主文字色底」，浅色海报反过来
      const [qrDark, qrLight] = luminance(bgRgb) < luminance(inkRgb) ? [BG, INK] : [INK, SURFACE]
      const qr = await loadImg(await QRCode.toDataURL(o.qrUrl, { margin: 1, width: 260, color: { dark: qrDark, light: qrLight } }))
      const qx = W - M - qs
      const qy = fy + 34
      ctx.fillStyle = qrLight
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
