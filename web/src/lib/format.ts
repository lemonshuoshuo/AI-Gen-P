import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

export { dayjs }

/** 北京时间的今天（YYYY-MM-DD），与服务端的日期判断保持一致 */
export function beijingToday() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export function fromNow(t: string | null | undefined) {
  if (!t) return ''
  const d = dayjs(t)
  if (dayjs().diff(d, 'day') > 30) return d.format('YYYY-MM-DD')
  return d.fromNow()
}

export function fmtDate(t: string | null | undefined, f = 'YYYY.MM.DD') {
  return t ? dayjs(t).format(f) : ''
}

export function fmtTime(t: string | null | undefined, f = 'MM-DD HH:mm') {
  return t ? dayjs(t).format(f) : ''
}

export function dateRange(start: string | null, end: string | null) {
  if (!start) return ''
  if (!end || end === start) return fmtDate(start)
  const s = dayjs(start)
  const e = dayjs(end)
  if (s.year() === e.year()) return `${s.format('YYYY.MM.DD')} - ${e.format('MM.DD')}`
  return `${s.format('YYYY.MM.DD')} - ${e.format('YYYY.MM.DD')}`
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function fmtCount(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

export function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** 路上用时（秒），按分钟四舍五入：「25 分钟」「1 小时 5 分钟」 */
export function fmtMinutes(seconds: number) {
  const m = Math.round(seconds / 60)
  if (m < 1) return '不到 1 分钟'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const r = m % 60
  return `${h} 小时${r > 0 ? ` ${r} 分钟` : ''}`
}
