// 坐标工具：WGS-84（GPS）与 GCJ-02（高德）互转、距离计算

/** 非 HTTPS 页面（http://localhost 除外）：浏览器一律禁止网页定位，报的却是「权限被拒绝」 */
export const insecureContext = typeof window !== 'undefined' && window.isSecureContext === false
export const INSECURE_GEO_MSG = '本站未启用 HTTPS，浏览器禁止网页获取定位，请联系站长开启 HTTPS'

const A = 6378245.0
const EE = 0.006693421622965943

/** 粗略的中国外接矩形之外（与服务端 geo.OutOfChina 一致）；矩形内的周边国家由 GCJ_EXCLUDE 排除 */
function outOfChina(lng: number, lat: number) {
  return !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271)
}

/**
 * 与 server/internal/geo/transform.go 的 gcjExclude 保持一致（日韩、东南亚、南亚、蒙俄、中亚等境外区域不做偏移）：
 * 外接矩形内不使用 GCJ-02 的区域，每行为 [minLng, minLat, maxLng, maxLat]（含边界），高德在境外使用 WGS-84
 */
const GCJ_EXCLUDE: readonly (readonly [number, number, number, number])[] = [
  [124.0, 30.0, 137.8347, 38.3], [124.0, 24.0, 137.8347, 25.4], [125.0, 25.4, 137.8347, 30.0],
  [119.3, 0.8293, 137.8347, 20.8], [123.0, 20.8, 137.8347, 24.0], [124.8, 38.3, 130.0, 40.0],
  [131.6, 42.3, 137.8347, 44.3], [135.5, 44.3, 137.8347, 55.8271], [88.0, 49.5, 115.0, 55.8271],
  [92.0, 46.0, 115.0, 49.5], [91.0, 47.5, 92.0, 49.5], [97.0, 43.5, 110.5, 46.0],
  [72.004, 42.0, 79.0, 55.8271], [79.0, 49.8, 86.5, 55.8271], [72.004, 40.2, 73.6, 42.0],
  [72.004, 0.8293, 88.0, 26.0], [72.004, 26.0, 78.0, 31.3], [72.004, 31.3, 75.8, 34.5],
  [78.0, 26.0, 80.0, 29.5], [80.0, 26.0, 86.5, 27.75], [82.0, 27.75, 84.3, 28.5],
  [86.5, 26.0, 88.0, 27.3], [89.45, 26.3, 91.3, 27.6], [88.0, 20.5, 92.3, 26.3],
  [92.3, 10.0, 97.0, 26.0], [92.3, 0.8293, 105.5, 20.0], [105.5, 0.8293, 109.0, 12.0],
  [105.5, 12.0, 109.6, 16.3], [102.2, 16.0, 107.8, 21.2], [109.5, 0.8293, 119.3, 3.3],
  [113.6, 3.3, 119.3, 6.5], [115.5, 6.5, 119.3, 7.5], [118.2, 7.5, 119.3, 12.5],
]

/** 该坐标是否使用 GCJ-02 偏移（国内）：在外接矩形内且不在 GCJ_EXCLUDE 的境外区域（与服务端 geo.InGCJArea 一致） */
export function inGcjArea(lng: number, lat: number) {
  if (outOfChina(lng, lat)) return false
  for (const [minLng, minLat, maxLng, maxLat] of GCJ_EXCLUDE) {
    if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) return false
  }
  return true
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

/** WGS-84 坐标处的 GCJ-02 偏移量 [dLng, dLat]（不判断区域） */
function gcjDelta(lng: number, lat: number): [number, number] {
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [dLng, dLat]
}

/** 境外（见 inGcjArea）原样返回 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!inGcjArea(lng, lat)) return [lng, lat]
  const [dLng, dLat] = gcjDelta(lng, lat)
  return [lng + dLng, lat + dLat]
}

/**
 * 不动点迭代反算（亚厘米级），境外原样返回。与服务端一致：只按输入点判断一次是否在偏移区域内，
 * 迭代过程中不会在区域边界上来回切换「偏移 / 不偏移」
 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!inGcjArea(lng, lat)) return [lng, lat]
  let wLng = lng
  let wLat = lat
  for (let i = 0; i < 30; i++) {
    const [dl, dt] = gcjDelta(wLng, wLat)
    const dLng = wLng + dl - lng
    const dLat = wLat + dt - lat
    wLng -= dLng
    wLat -= dLat
    if (Math.abs(dLng) < 1e-10 && Math.abs(dLat) < 1e-10) break
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
    if (insecureContext) {
      reject(new Error(INSECURE_GEO_MSG))
      return
    }
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
