// 中国省/市边界（服务端 /api/v1/geo/atlas 提供 TopoJSON）
import { feature } from 'topojson-client'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { Topology } from 'topojson-specification'
import { wgs84ToGcj02 } from './geo'

export interface AtlasProps {
  id: string
  name: string
}
export type AtlasFC = FeatureCollection<Polygon | MultiPolygon, AtlasProps>

let cache: Promise<{ provinces: AtlasFC; prefectures: AtlasFC; nation: AtlasFC }> | null = null

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
      .then((topo) => {
        const get = (k: string) => toGcj(feature(topo, topo.objects[k]) as unknown as FeatureCollection)
        return { provinces: get('provinces'), prefectures: get('prefectures'), nation: get('nation') }
      })
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}
