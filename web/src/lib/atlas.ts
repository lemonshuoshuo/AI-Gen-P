// 中国行政区划边界（服务端 /api/v1/geo/atlas 提供 TopoJSON，含省、地市、国界）。
// 省界：点亮省份、底图加载失败时的兜底轮廓；地市：足迹地图放大到省级时点亮去过的城市（按需只取用到的几个省）
import { feature } from 'topojson-client'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { GeometryCollection, Topology } from 'topojson-specification'
import { wgs84ToGcj02 } from './geo'

export interface AtlasProps {
  id: string
  name: string
}
export type AtlasFC = FeatureCollection<Polygon | MultiPolygon, AtlasProps>

let topoCache: Promise<Topology> | null = null
let cache: Promise<{ provinces: AtlasFC }> | null = null

// 边界数据为 WGS-84，底图为 GCJ-02，转换后贴合更准确
function toGcj(fc: FeatureCollection): AtlasFC {
  const conv = (ring: number[][]) => ring.map(([x, y]) => wgs84ToGcj02(x, y))
  for (const f of fc.features) {
    const g = f.geometry as Polygon | MultiPolygon
    if (g.type === 'Polygon') g.coordinates = g.coordinates.map(conv)
    else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((p) => p.map(conv))
    const p = (f.properties ?? {}) as Record<string, string>
    f.properties = { id: String(p.id ?? p['区划码'] ?? ''), name: String(p['地名'] ?? p.name ?? '') }
  }
  return fc as AtlasFC
}

function loadTopology() {
  if (!topoCache) {
    topoCache = fetch('/api/v1/geo/atlas')
      .then((r) => {
        if (!r.ok) throw new Error('边界数据加载失败')
        return r.json() as Promise<Topology>
      })
      .catch((e) => {
        topoCache = null
        throw e
      })
  }
  return topoCache
}

export function loadAtlas() {
  if (!cache) {
    cache = loadTopology()
      // 只转换省界：地市边界的顶点数是省界的 2.5 倍，逐点坐标转换在主线程上要多花几倍时间，转换结果还一直缓存在内存里
      .then((topo) => ({ provinces: toGcj(feature(topo, topo.objects.provinces) as unknown as FeatureCollection) }))
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}

// 地市边界按省缓存：只解码、转换用到的省份（一般只有几个），不做整张全国地市图
const prefCache = new Map<string, AtlasFC['features']>()

/** 给定省级编码（如 330000）下的全部地级行政区边界（GCJ-02）；直辖市、港澳台为一整块 */
export async function loadPrefectures(provinceCodes: string[]): Promise<AtlasFC> {
  const want = [...new Set(provinceCodes.map((c) => c.slice(0, 2)))].filter(Boolean)
  const missing = want.filter((p) => !prefCache.has(p))
  if (missing.length) {
    const topo = await loadTopology()
    const all = topo.objects.prefectures as GeometryCollection
    const geometries = all.geometries.filter((g) => {
      const id = String((g.properties as Record<string, unknown> | undefined)?.id ?? '')
      return missing.includes(id.slice(0, 2))
    })
    const fc = toGcj(feature(topo, { ...all, geometries }) as unknown as FeatureCollection)
    for (const p of missing) prefCache.set(p, [])
    for (const f of fc.features) prefCache.get(f.properties.id.slice(0, 2))?.push(f)
  }
  return { type: 'FeatureCollection', features: want.flatMap((p) => prefCache.get(p) ?? []) }
}
