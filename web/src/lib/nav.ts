// 唤起手机地图 App / 网页地图（坐标均为 GCJ-02）
export interface NavTarget {
  lng: number
  lat: number
  name: string
  address?: string
}

const SRC = 'triphub'

export const isMobile = () => /Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent)
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent)
/** 微信内置浏览器（含企业微信、小程序 web-view）：不允许网页唤起白名单以外的 App，相册选图也常被去掉位置信息 */
export const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent)
/** 高德 URI 的 callnative：微信里唤起不了高德 App，直接打开网页版 */
const amapNative = () => (isWeChat() ? 0 : 1)

/** 出行方式（取值与高德 URI 的 mode 一致） */
export type NavMode = 'walk' | 'bus' | 'ride' | 'car'

export const navModes: { value: NavMode; label: string }[] = [
  { value: 'walk', label: '步行' },
  { value: 'bus', label: '公交' },
  { value: 'ride', label: '骑行' },
  { value: 'car', label: '驾车' },
]

const NAV_MODE_KEY = 'triphub.nav-mode'

/** 记住用户手动选择的出行方式（不知道距离时作为默认） */
export function rememberNavMode(m: NavMode) {
  try {
    localStorage.setItem(NAV_MODE_KEY, m)
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

/** 默认出行方式：知道距离时按距离选（近处步行、市内公交、远处驾车），否则用上次选的，都没有时驾车 */
export function defaultNavMode(distanceM?: number | null): NavMode {
  if (distanceM != null && Number.isFinite(distanceM)) return distanceM < 1500 ? 'walk' : distanceM < 15000 ? 'bus' : 'car'
  try {
    const v = localStorage.getItem(NAV_MODE_KEY)
    if (navModes.some((m) => m.value === v)) return v as NavMode
  } catch {
    /* 忽略 */
  }
  return 'car'
}

const baiduMode: Record<NavMode, string> = { walk: 'walking', bus: 'transit', ride: 'riding', car: 'driving' }
const tencentMode: Record<NavMode, string> = { walk: 'walk', bus: 'bus', ride: 'bike', car: 'drive' }
// Apple 地图的网址没有骑行参数：骑行时不指定，由地图 App 自行选择
const appleMode: Record<NavMode, string> = { walk: '&dirflg=w', bus: '&dirflg=r', ride: '', car: '&dirflg=d' }

export interface NavProvider {
  key: string
  name: string
  /** 查看位置 */
  marker: (t: NavTarget) => string
  /** 导航到该点 */
  route: (t: NavTarget, mode: NavMode) => string
  iosOnly?: boolean
}

export const navProviders: NavProvider[] = [
  {
    key: 'amap',
    name: '高德地图',
    marker: (t) =>
      `https://uri.amap.com/marker?position=${t.lng},${t.lat}&name=${encodeURIComponent(t.name)}&src=${SRC}&coordinate=gaode&callnative=${amapNative()}`,
    route: (t, mode) =>
      `https://uri.amap.com/navigation?to=${t.lng},${t.lat},${encodeURIComponent(t.name)}&mode=${mode}&src=${SRC}&coordinate=gaode&callnative=${amapNative()}`,
  },
  {
    key: 'baidu',
    name: '百度地图',
    marker: (t) =>
      `https://api.map.baidu.com/marker?location=${t.lat},${t.lng}&title=${encodeURIComponent(t.name)}&content=${encodeURIComponent(t.address ?? t.name)}&output=html&coord_type=gcj02&src=${SRC}`,
    route: (t, mode) =>
      `https://api.map.baidu.com/direction?destination=latlng:${t.lat},${t.lng}|name:${encodeURIComponent(t.name)}&mode=${baiduMode[mode]}&region=${encodeURIComponent('全国')}&output=html&coord_type=gcj02&src=${SRC}`,
  },
  {
    key: 'tencent',
    name: '腾讯地图',
    marker: (t) =>
      `https://apis.map.qq.com/uri/v1/marker?marker=coord:${t.lat},${t.lng};title:${encodeURIComponent(t.name)};addr:${encodeURIComponent(t.address ?? '')}&referer=${SRC}`,
    route: (t, mode) =>
      `https://apis.map.qq.com/uri/v1/routeplan?type=${tencentMode[mode]}&to=${encodeURIComponent(t.name)}&tocoord=${t.lat},${t.lng}&referer=${SRC}`,
  },
  {
    key: 'apple',
    name: 'Apple 地图',
    // 苹果地图在中国大陆使用高德数据，GCJ-02 坐标可直接使用
    marker: (t) => `https://maps.apple.com/?ll=${t.lat},${t.lng}&q=${encodeURIComponent(t.name)}`,
    route: (t, mode) => `https://maps.apple.com/?daddr=${t.lat},${t.lng}&q=${encodeURIComponent(t.name)}${appleMode[mode]}`,
    iosOnly: true,
  },
]

/** 高德 URI 最多 16 个途经点 */
export const AMAP_MAX_VIA = 16
/** 一次最多规划的站数：起点 + 途经点 + 终点 */
export const AMAP_MAX_STOPS = AMAP_MAX_VIA + 2

/**
 * 多点路线：打开高德网页/App 规划（高德 URI 仅支持起终点 + 途经点列表；途经点只有驾车规划支持，最多 16 个）。
 * 超出时只规划连续的前 AMAP_MAX_STOPS 站（而不是跳过中间直接到最后一站），由调用方提示
 */
export function amapMultiRoute(points: NavTarget[]) {
  const pts = points.slice(0, AMAP_MAX_STOPS)
  if (pts.length < 2) return pts[0] ? navProviders[0].route(pts[0], 'car') : ''
  const from = pts[0]
  const to = pts[pts.length - 1]
  const via = pts.slice(1, -1)
  let url = `https://uri.amap.com/navigation?from=${from.lng},${from.lat},${encodeURIComponent(from.name)}&to=${to.lng},${to.lat},${encodeURIComponent(to.name)}&mode=car&src=${SRC}&coordinate=gaode&callnative=${amapNative()}`
  if (via.length) {
    url += `&via=${via.map((v) => `${v.lng},${v.lat},${encodeURIComponent(v.name)}`).join(';')}`
  }
  return url
}
