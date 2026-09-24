// 中国省界（服务端 /api/v1/geo/atlas 提供 TopoJSON，含省、地市、国界；页面只用到省界：点亮省份、底图加载失败时的兜底轮廓）
import { feature } from 'topojson-client'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { Topology } from 'topojson-specification'
import { wgs84ToGcj02 } from './geo'

export interface AtlasProps {
  id: string
  name: string
}
export type AtlasFC = FeatureCollection<Polygon | MultiPolygon, AtlasProps>

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

export function loadAtlas() {
  if (!cache) {
    cache = fetch('/api/v1/geo/atlas')
      .then((r) => {
        if (!r.ok) throw new Error('边界数据加载失败')
        return r.json() as Promise<Topology>
      })
      // 只转换省界：地市边界的顶点数是省界的 2.5 倍，逐点坐标转换在主线程上要多花几倍时间，转换结果还一直缓存在内存里
      .then((topo) => ({ provinces: toGcj(feature(topo, topo.objects.provinces) as unknown as FeatureCollection) }))
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}
