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

export interface NavProvider {
  key: string
  name: string
  /** 查看位置 */
  marker: (t: NavTarget) => string
  /** 导航到该点 */
  route: (t: NavTarget) => string
  iosOnly?: boolean
}

export const navProviders: NavProvider[] = [
  {
    key: 'amap',
    name: '高德地图',
    marker: (t) =>
      `https://uri.amap.com/marker?position=${t.lng},${t.lat}&name=${encodeURIComponent(t.name)}&src=${SRC}&coordinate=gaode&callnative=1`,
    route: (t) =>
      `https://uri.amap.com/navigation?to=${t.lng},${t.lat},${encodeURIComponent(t.name)}&mode=car&src=${SRC}&coordinate=gaode&callnative=1`,
  },
  {
    key: 'baidu',
    name: '百度地图',
    marker: (t) =>
      `https://api.map.baidu.com/marker?location=${t.lat},${t.lng}&title=${encodeURIComponent(t.name)}&content=${encodeURIComponent(t.address ?? t.name)}&output=html&coord_type=gcj02&src=${SRC}`,
    route: (t) =>
      `https://api.map.baidu.com/direction?destination=latlng:${t.lat},${t.lng}|name:${encodeURIComponent(t.name)}&mode=driving&region=${encodeURIComponent('全国')}&output=html&coord_type=gcj02&src=${SRC}`,
  },
  {
    key: 'tencent',
    name: '腾讯地图',
    marker: (t) =>
      `https://apis.map.qq.com/uri/v1/marker?marker=coord:${t.lat},${t.lng};title:${encodeURIComponent(t.name)};addr:${encodeURIComponent(t.address ?? '')}&referer=${SRC}`,
    route: (t) =>
      `https://apis.map.qq.com/uri/v1/routeplan?type=drive&to=${encodeURIComponent(t.name)}&tocoord=${t.lat},${t.lng}&referer=${SRC}`,
  },
  {
    key: 'apple',
    name: 'Apple 地图',
    // 苹果地图在中国大陆使用高德数据，GCJ-02 坐标可直接使用
    marker: (t) => `https://maps.apple.com/?ll=${t.lat},${t.lng}&q=${encodeURIComponent(t.name)}`,
    route: (t) => `https://maps.apple.com/?daddr=${t.lat},${t.lng}&q=${encodeURIComponent(t.name)}&dirflg=d`,
    iosOnly: true,
  },
]

/** 多点路线：打开高德网页/App 规划（高德 URI 仅支持起终点 + 途经点列表） */
export function amapMultiRoute(points: NavTarget[]) {
  if (points.length < 2) return points[0] ? navProviders[0].route(points[0]) : ''
  const from = points[0]
  const to = points[points.length - 1]
  const via = points.slice(1, -1).slice(0, 16)
  let url = `https://uri.amap.com/navigation?from=${from.lng},${from.lat},${encodeURIComponent(from.name)}&to=${to.lng},${to.lat},${encodeURIComponent(to.name)}&mode=car&src=${SRC}&coordinate=gaode&callnative=1`
  if (via.length) {
    url += `&via=${via.map((v) => `${v.lng},${v.lat},${encodeURIComponent(v.name)}`).join(';')}`
  }
  return url
}
