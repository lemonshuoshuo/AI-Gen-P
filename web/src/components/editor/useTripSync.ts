import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type TripDetail, type TripEditor, type TripRevision, type UserBrief, type Waypoint } from '@/api'
import { isLodging } from '@/components/trip/plan'
import { diffPlan } from './planDraft'

/**
 * 行程页、旅行模式：定时查一次旅程的版本号（GET /trips/:id/revision，很轻量），比已加载的新时调用 onNewer（重新获取旅程），
 * 同行的人新加的地点、打卡不用刷新页面就能看到。页面不可见时暂停，回到前台时立即查一次；旅程不可见（404 / 403）后停止。
 * 返回正在编辑这段旅程的成员（只有成员能看到，包括自己）
 */
export function useRevisionPoll(
  tripId: number | undefined,
  loadedRevision: number | undefined,
  onNewer: (r: TripRevision) => void,
  { interval = 10_000, enabled = true }: { interval?: number; enabled?: boolean } = {},
) {
  const loaded = useRef(loadedRevision ?? 0)
  loaded.current = loadedRevision ?? 0
  const cb = useRef(onNewer)
  cb.current = onNewer
  const [editors, setEditors] = useState<TripEditor[]>([])
  useEffect(() => {
    if (!tripId || !enabled) return
    let stopped = false
    let inflight = false
    const tick = () => {
      if (stopped || inflight || document.visibilityState !== 'visible') return
      inflight = true
      api.trips
        .revision(tripId)
        .then((r) => {
          if (stopped) return
          const sig = (l: TripEditor[]) => l.map((e) => `${e.user.id}:${e.since}`).join()
          setEditors((cur) => (sig(cur) === sig(r.editors) ? cur : r.editors))
          // 0：看不到进度的人（旅行中未开启实时公开的非成员），不会变
          if (r.revision > loaded.current && loaded.current > 0) cb.current(r)
        })
        .catch((e) => {
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) stopped = true
        })
        .finally(() => {
          inflight = false
        })
    }
    const first = setTimeout(tick, 1000)
    const t = setInterval(tick, interval)
    const onVis = () => document.visibilityState === 'visible' && tick()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tripId, enabled, interval])
  return { editors }
}

const who = (u: UserBrief) => u.nickname || u.username

/**
 * 同行的人改了什么（给提示用，一句话）：新打卡的地点，或计划的修改（新增、删除、换天…）。
 * 看不出变化（如只是整理了顺序编号、传了照片）时返回 null，不打扰
 */
export function describeUpdate(before: TripDetail | undefined, after: TripDetail, by: UserBrief | null): string | null {
  if (!before || !by) return null
  const old = new Map(before.waypoints.map((w) => [w.id, w]))
  const name = (w: Waypoint) => `「${w.name || '地点'}」`
  const checked = after.waypoints.filter((w) => w.status === 'visited' && old.get(w.id)?.status !== 'visited' && !isLodging(w))
  if (checked.length) return `${who(by)} 打卡了${checked.slice(0, 2).map(name).join('、')}${checked.length > 2 ? ` 等 ${checked.length} 处` : ''}`
  const changes = diffPlan(before, after, after.phase === 'planning' ? '想去的地方' : '未分天')
  if (!changes.length) return null
  return `${who(by)}：${changes[0].text}${changes.length > 1 ? ` 等 ${changes.length} 处修改` : ''}`
}
