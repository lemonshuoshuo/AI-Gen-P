import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import type { TrackPointIn } from '@/api/types'
import { INSECURE_GEO_MSG, haversine, insecureContext, wgs84ToGcj02 } from '@/lib/geo'
import { isRetryable } from '@/lib/outbox'

export interface GeoFix {
  wgs: [number, number]
  gcj: [number, number]
  accuracy: number
  alt?: number
  speed?: number
  t: number
}

const BUFFER_KEY = (tripId: number) => `triphub.track-buffer.${tripId}`

/** 丢弃本机尚未上传的轨迹点（清空轨迹时调用，避免下次打开旅行模式又传上去） */
export function dropTrackBuffer(tripId: number) {
  try {
    localStorage.removeItem(BUFFER_KEY(tripId))
  } catch {
    /* 隐私模式下可能不可用 */
  }
}
// 正在记录的会话：刷新页面、浏览器回收标签页后回到旅行模式时自动接着记录
const SESSION_KEY = (tripId: number) => `triphub.recording.${tripId}`
const SESSION_MAX_AGE = 12 * 3600_000
const FLUSH_INTERVAL = 15_000
const MIN_DIST = 5 // 米
const MAX_ACCURACY = 60 // 米

/** 实时定位 + 轨迹记录（离线缓冲，定时批量上传） */
export function useGeoTracker(tripId: number) {
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [error, setError] = useState<string | null>(insecureContext ? INSECURE_GEO_MSG : null)
  /** 无法定位且不会自行恢复（非 HTTPS 页面、定位权限被拒绝）：不能开始记录轨迹 */
  const [blocked, setBlocked] = useState(insecureContext)
  const [recording, setRecording] = useState(false)
  /** 本页记录的实时轨迹（GCJ-02），每次开始记录另起一段：两次记录之间不连线 */
  const [livePaths, setLivePaths] = useState<[number, number][][]>([])
  const [recordedKm, setRecordedKm] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  /** 本次是自动恢复的记录（页面刷新或被回收后重新打开） */
  const [resumed, setResumed] = useState(false)
  const recRef = useRef(false)
  const segmentRef = useRef(0)
  const lastRef = useRef<GeoFix | null>(null)
  const bufferRef = useRef<(TrackPointIn & { seg: number })[]>([])
  const wakeRef = useRef<WakeLockSentinel | null>(null)
  const flushChainRef = useRef<Promise<void>>(Promise.resolve())

  // 恢复上次未上传的点
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BUFFER_KEY(tripId))
      if (raw) bufferRef.current = JSON.parse(raw)
    } catch {
      /* 忽略 */
    }
  }, [tripId])

  const persist = () => {
    try {
      if (bufferRef.current.length) localStorage.setItem(BUFFER_KEY(tripId), JSON.stringify(bufferRef.current))
      else localStorage.removeItem(BUFFER_KEY(tripId))
    } catch {
      /* 存储满 */
    }
  }

  // 只上传调用时的快照；成功后只移除这些点，上传途中新记录的点留到下一次
  const uploadOnce = async () => {
    const batch = bufferRef.current.slice() // 复制，不要引用正在增长的数组
    if (!batch.length) return
    const bySeg = new Map<number, TrackPointIn[]>()
    for (const { seg, ...p } of batch) {
      const list = bySeg.get(seg) ?? []
      list.push(p)
      bySeg.set(seg, list)
    }
    try {
      for (const [seg, pts] of bySeg) {
        for (let i = 0; i < pts.length; i += 1000) await api.trips.appendTrack(tripId, pts.slice(i, i + 1000), seg)
      }
      bufferRef.current = bufferRef.current.slice(batch.length)
    } catch (e) {
      // 网络不好、服务器暂时不可用时保留在缓冲区，稍后重试（服务端按 trip/user/segment/时间去重，重发安全）；
      // 服务端明确拒绝（旅程轨迹点已达上限 413、已不是旅程成员、旅程已删除等）时重发也不会成功，丢弃这批点，免得一直卡在缓冲区
      if (!isRetryable(e)) {
        bufferRef.current = bufferRef.current.slice(batch.length)
        toast.error(`${batch.length} 个轨迹点未能保存：${errorMessage(e)}`, { id: 'track-upload' })
      }
    }
    persist()
  }

  // 串行：同一时间只有一个上传；并发调用排队，stop() 会等之前的上传和剩余的点都发完
  const flush = useCallback((): Promise<void> => {
    persist() // 先同步写入本地，请求途中页面被冻结 / 回收也不丢点
    const p = flushChainRef.current.then(uploadOnce, uploadOnce)
    flushChainRef.current = p
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  useEffect(() => {
    if (insecureContext) return
    if (!('geolocation' in navigator)) {
      setError('当前浏览器不支持定位')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const wgs: [number, number] = [pos.coords.longitude, pos.coords.latitude]
        const f: GeoFix = {
          wgs,
          gcj: wgs84ToGcj02(wgs[0], wgs[1]),
          accuracy: pos.coords.accuracy,
          alt: pos.coords.altitude ?? undefined,
          speed: pos.coords.speed ?? undefined,
          t: pos.timestamp,
        }
        setFix(f)
        setError(null)
        setBlocked(false)
        if (!recRef.current || f.accuracy > MAX_ACCURACY) return
        const last = lastRef.current
        const d = last ? haversine(last.wgs, f.wgs) : Infinity
        // 只有移出前后两次定位的误差圈才算真的移动：静止/室内时的定位漂移不计入轨迹和里程
        if (last && d < Math.max(MIN_DIST, f.accuracy + last.accuracy)) return
        if (last) setRecordedKm((k) => k + d / 1000)
        lastRef.current = f
        bufferRef.current.push({
          seg: segmentRef.current,
          lng: wgs[0],
          lat: wgs[1],
          alt: f.alt,
          acc: f.accuracy,
          speed: f.speed,
          t: f.t,
        })
        setLivePaths((segs) => {
          const cur = segs[segs.length - 1] ?? []
          return [...segs.slice(0, -1), [...cur, f.gcj]]
        })
      },
      (err) => {
        // 权限被拒绝后这次监听已经结束：允许定位后要刷新页面才会重新开始
        const denied = err.code === err.PERMISSION_DENIED
        if (denied) setBlocked(true)
        setError(denied ? '定位权限被拒绝，请在浏览器设置里允许定位后刷新页面' : '暂时无法获取位置')
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  useEffect(() => {
    const t = setInterval(flush, FLUSH_INTERVAL)
    const onHide = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', persist)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', persist)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush])

  const releaseWakeLock = () => {
    wakeRef.current?.release().catch(() => {})
    wakeRef.current = null
  }

  const acquireWakeLock = async () => {
    try {
      if (!('wakeLock' in navigator)) return
      const s = await navigator.wakeLock.request('screen')
      // 申请途中已停止记录（或离开了页面）：立即释放，否则屏幕会一直常亮
      if (!recRef.current) {
        s.release().catch(() => {})
        return
      }
      releaseWakeLock()
      wakeRef.current = s
    } catch {
      /* 不支持时忽略 */
    }
  }

  const saveSession = (at: number) => {
    try {
      localStorage.setItem(SESSION_KEY(tripId), JSON.stringify({ startedAt: at }))
    } catch {
      /* 忽略 */
    }
  }

  // 页面切回前台时重新申请常亮；离开页面时停止记录并释放常亮（记录会话保留，回来后自动恢复）
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && recRef.current && acquireWakeLock()
    document.addEventListener('visibilitychange', on)
    return () => {
      document.removeEventListener('visibilitychange', on)
      recRef.current = false
      releaseWakeLock()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 上次记录时页面被刷新、关闭或回收：自动恢复记录。用新的分段，中断期间既不画线也不计入里程
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY(tripId))
      if (!raw) return
      const { startedAt: at } = JSON.parse(raw) as { startedAt?: number }
      if (!at || Date.now() - at > SESSION_MAX_AGE) {
        localStorage.removeItem(SESSION_KEY(tripId))
        return
      }
      const now = Date.now()
      segmentRef.current = Math.floor(now / 1000)
      recRef.current = true
      lastRef.current = null
      setRecording(true)
      setStartedAt(now)
      saveSession(now)
      setResumed(true)
      acquireWakeLock()
    } catch {
      /* 忽略 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  // 记录中刷新或关闭页面时提醒
  useEffect(() => {
    if (!recording) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [recording])

  const start = (segment: number) => {
    const now = Date.now()
    segmentRef.current = segment
    recRef.current = true
    lastRef.current = null
    // 里程和计时一样只算这一次记录；已上传的旧段服务器轨迹里已有，未上传（离线）时保留但另起一段
    setRecordedKm(0)
    const keepOld = bufferRef.current.length > 0
    setLivePaths((segs) => [...(keepOld ? segs : []), []])
    setRecording(true)
    setStartedAt(now)
    saveSession(now)
    acquireWakeLock()
  }
  const stop = async () => {
    recRef.current = false
    setRecording(false)
    setStartedAt(null)
    setResumed(false)
    try {
      localStorage.removeItem(SESSION_KEY(tripId))
    } catch {
      /* 忽略 */
    }
    releaseWakeLock()
    await flush()
  }

  return { fix, error, blocked, recording, resumed, livePaths, recordedKm, startedAt, start, stop, flush }
}
