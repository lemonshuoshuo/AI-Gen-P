// 坐标工具：WGS-84（GPS）与 GCJ-02（高德）互转、距离计算
const A = 6378245.0
const EE = 0.006693421622965943

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return r
}

function transformLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return r
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lng + dLng, lat + dLat]
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  let [wLng, wLat] = [lng, lat]
  for (let i = 0; i < 5; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat)
    wLng += lng - gLng
    wLat += lat - gLat
  }
  return [wLng, wLat]
}

/** 两点距离（米） */
export function haversine(a: [number, number], b: [number, number]) {
  const R = 6371008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function pathLength(path: [number, number][]) {
  let d = 0
  for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i])
  return d
}

export function bounds(points: [number, number][]): [[number, number], [number, number]] | null {
  if (!points.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ]
}

/** 方位角（度，正北为 0，顺时针） */
export function bearing(a: [number, number], b: [number, number]) {
  const toRad = (d: number) => (d * Math.PI) / 180
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]))
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export const CHINA_CENTER: [number, number] = [104.2, 35.8]

export function formatDistance(m: number | null | undefined) {
  if (m == null || Number.isNaN(m)) return ''
  if (m < 1000) return `${Math.round(m)} 米`
  if (m < 100_000) return `${(m / 1000).toFixed(1)} 公里`
  return `${Math.round(m / 1000)} 公里`
}

export function formatKm(km: number | null | undefined) {
  if (!km) return '0 公里'
  if (km < 1) return `${Math.round(km * 1000)} 米`
  if (km < 100) return `${km.toFixed(1)} 公里`
  return `${Math.round(km).toLocaleString()} 公里`
}

/** 浏览器定位（返回 WGS-84 与 GCJ-02） */
export function getCurrentPosition(timeout = 10000): Promise<{
  wgs: [number, number]
  gcj: [number, number]
  accuracy: number
}> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('当前浏览器不支持定位'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const wgs: [number, number] = [pos.coords.longitude, pos.coords.latitude]
        resolve({ wgs, gcj: wgs84ToGcj02(wgs[0], wgs[1]), accuracy: pos.coords.accuracy })
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? '定位权限被拒绝，请在浏览器设置中允许定位'
            : err.code === err.TIMEOUT
              ? '定位超时，请到开阔处再试'
              : '无法获取位置'
        reject(new Error(msg))
      },
      { enableHighAccuracy: true, timeout, maximumAge: 5000 },
    )
  })
}
