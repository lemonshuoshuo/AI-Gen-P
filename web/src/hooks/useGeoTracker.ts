import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { TrackPointIn } from '@/api/types'
import { haversine, wgs84ToGcj02 } from '@/lib/geo'

export interface GeoFix {
  wgs: [number, number]
  gcj: [number, number]
  accuracy: number
  alt?: number
  speed?: number
  t: number
}

const BUFFER_KEY = (tripId: number) => `triphub.track-buffer.${tripId}`
const FLUSH_INTERVAL = 15_000
const MIN_DIST = 5 // 米
const MAX_ACCURACY = 60 // 米

/** 实时定位 + 轨迹记录（离线缓冲，定时批量上传） */
export function useGeoTracker(tripId: number) {
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [livePath, setLivePath] = useState<[number, number][]>([])
  const [recordedKm, setRecordedKm] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const recRef = useRef(false)
  const segmentRef = useRef(0)
  const lastRef = useRef<GeoFix | null>(null)
  const bufferRef = useRef<(TrackPointIn & { seg: number })[]>([])
  const wakeRef = useRef<WakeLockSentinel | null>(null)

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

  const flush = useCallback(async () => {
    const buf = bufferRef.current
    if (!buf.length) return
    const bySeg = new Map<number, TrackPointIn[]>()
    for (const { seg, ...p } of buf) {
      const list = bySeg.get(seg) ?? []
      list.push(p)
      bySeg.set(seg, list)
    }
    try {
      for (const [seg, pts] of bySeg) {
        for (let i = 0; i < pts.length; i += 1000) await api.trips.appendTrack(tripId, pts.slice(i, i + 1000), seg)
      }
      bufferRef.current = bufferRef.current.slice(buf.length)
      persist()
    } catch {
      persist() // 网络不好时先存本地，稍后重试
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId])

  useEffect(() => {
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
        if (!recRef.current || f.accuracy > MAX_ACCURACY) return
        const last = lastRef.current
        const d = last ? haversine(last.wgs, f.wgs) : Infinity
        if (last && d < MIN_DIST && f.t - last.t < 30_000) return
        if (last && d !== Infinity) setRecordedKm((k) => k + d / 1000)
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
        setLivePath((p) => [...p, f.gcj])
      },
      (err) => {
        setError(err.code === err.PERMISSION_DENIED ? '定位权限被拒绝，请在浏览器设置里允许定位' : '暂时无法获取位置')
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  useEffect(() => {
    const t = setInterval(flush, FLUSH_INTERVAL)
    const onHide = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

  const acquireWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) wakeRef.current = await navigator.wakeLock.request('screen')
    } catch {
      /* 不支持时忽略 */
    }
  }

  // 页面切回前台时重新申请常亮
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && recRef.current && acquireWakeLock()
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  const start = (segment: number) => {
    segmentRef.current = segment
    recRef.current = true
    lastRef.current = null
    setRecording(true)
    setStartedAt(Date.now())
    acquireWakeLock()
  }
  const stop = async () => {
    recRef.current = false
    setRecording(false)
    setStartedAt(null)
    wakeRef.current?.release().catch(() => {})
    wakeRef.current = null
    await flush()
  }

  return { fix, error, recording, livePath, recordedKm, startedAt, start, stop, flush }
}
