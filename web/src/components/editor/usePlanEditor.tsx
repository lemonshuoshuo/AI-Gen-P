/**
 * 路线编辑的数据层：本地草稿 + 一次性保存 + 多人协同（API.md「协同编辑」）。
 *
 * - 计划的修改（加 / 删 / 排序 / 换天 / 住宿 / 天数 / 出行方式 / 一键排路线 / 旅程信息）只改本机的草稿，立即生效、不发请求；
 *   草稿同时暂存在本机，页面意外关闭后可以恢复。「保存」用 PUT /trips/:id/plan 一次提交，带上草稿所基于的版本号
 * - 别人保存了新版本：草稿没改过时直接换成新版本；改过时只在页面上提示，保存时服务端返回 409，由用户选择载入对方的版本
 *   或用自己的版本覆盖。打卡进度、照片这类不和计划冲突的修改自动合进草稿
 * - 不属于计划的修改（打卡状态与到达时间、删除打卡记录、补记已去过的地点、照片、成员）仍然立即调用各自的接口
 * - 编辑页打开期间每 20 秒发一次「正在编辑」的心跳，每 5 秒查一次版本号（页面不可见时暂停）
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  api,
  ApiError,
  errorMessage,
  type ArrangeInput,
  type ArrangeResult,
  type PlanConflict,
  type TravelMode,
  type TripDetail,
  type TripEditor,
  type TripRevision,
  type UserBrief,
  type Waypoint,
  type WaypointInput,
} from '@/api'
import { canonicalOrder, groupPlan, isLodging } from '@/components/trip/plan'
import { confirmDialog } from '@/components/ui'
import { invalidateTripLists } from '@/lib/cache'
import { bySeq } from '@/lib/trip'
import { useAuth } from '@/stores/auth'
import {
  addStop as addStopOp,
  applyArrangement as applyArrangementOp,
  blockingChanges,
  clearStoredDraft,
  clientKey,
  diffPlan,
  hasHistory,
  isNew,
  loadStoredDraft,
  lodgingInputFrom,
  makeLodging as makeLodgingOp,
  merge3,
  moveLodging,
  newWaypoint,
  patchWaypoint,
  placeInDay,
  planPayload,
  remapIds,
  removeWaypoint,
  renumber,
  restoreWaypoint,
  setDays as setDaysOp,
  setLodging as setLodgingOp,
  setTripFields,
  storeDraft,
  type PlanChange,
  type StoredDraft,
  type TripField,
  type WpField,
} from './planDraft'

type LngLat = [number, number]

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

/** 补记已去过的地点（立即保存）：列表里显示一行「正在添加…」 */
export interface PendingAdd {
  key: number
  name: string
  day: number
  lodging?: boolean
}

/** 保存时发现（或横幅上提前查看）别人保存了新版本 */
export interface PlanConflictState {
  /** 服务端的最新版本 */
  remote: TripDetail
  by: UserBrief | null
  at: string
  source: 'save' | 'banner'
}

export interface SaveResult {
  ok: boolean
  /** 新地点：临时 ID → 保存后的 ID */
  idMap?: Map<number, number>
  /** 想删除、但因已打卡或有照片而保留的地点 */
  kept?: Waypoint[]
  conflict?: boolean
}

interface EditorState {
  /** 草稿所基于的版本（服务端的某个版本；它的 revision 就是保存时的 base_revision） */
  base: TripDetail | null
  draft: TripDetail | null
  /** 别人保存的新版本：草稿有未保存的修改，先不合并 */
  incoming: TripDetail | null
  /** 「小梅 刚刚保存了修改」 */
  notice: { by: UserBrief | null; at: string; revision: number } | null
  noticeDismissed: number
  conflict: PlanConflictState | null
  saving: boolean
  saveError: string | null
  /** 上次没保存的草稿（打开页面时询问是否恢复）：明确选「不用了」之前一直留着 */
  restore: StoredDraft | null
  /** 询问恢复的窗口被关掉了（Esc、点背景）：草稿还在，标题下给一个「恢复上次的修改」 */
  restoreHidden: boolean
  /** 刚刚把别人的修改同步了过来（几秒后消失） */
  synced: { by: UserBrief; text: string; count: number; at: number } | null
  /** 同时在编辑的其他成员 */
  editors: TripEditor[]
  busy: ReadonlyMap<number, number>
  adding: PendingAdd[]
  /** 保存时出错的那一项 */
  errorId: number | null
}

const initial: EditorState = {
  base: null,
  draft: null,
  incoming: null,
  notice: null,
  noticeDismissed: 0,
  conflict: null,
  saving: false,
  saveError: null,
  restore: null,
  restoreHidden: false,
  synced: null,
  editors: [],
  busy: new Map(),
  adding: [],
  errorId: null,
}

export const poolNameOf = (t: Pick<TripDetail, 'phase'> | null | undefined) => (t?.phase === 'planning' ? '想去的地方' : '未分天')

const label = (w: Pick<Waypoint, 'name' | 'address'> | undefined) => (w ? `「${w.name || w.address || '未命名地点'}」` : '')

// 到达时间按分钟比较：表单里的时间只到分钟，原样保存不应把打卡的秒数改掉（ActualRoute 按到达时间排序）
const minuteOf = (t: string | null | undefined) => (t ? Math.floor(Date.parse(t) / 60_000) : null)
const sameMinute = (a: string | null | undefined, b: string | null | undefined) => minuteOf(a) === minuteOf(b)

const POLL_MS = 5_000
const HEARTBEAT_MS = 20_000

// 编辑页卸载后稍等再发「不再编辑」：开发模式的 StrictMode、同一旅程的编辑页重新挂载时不会闪一下「离开」
const pendingLeave = new Map<number, ReturnType<typeof setTimeout>>()

export function usePlanEditor(tripId: number) {
  const qc = useQueryClient()
  const meId = useAuth((s) => s.user?.id ?? 0)
  const key = useMemo(() => ['trip', String(tripId)], [tripId])
  const query = useQuery({ queryKey: key, queryFn: () => api.trips.get(tripId), refetchOnMount: 'always' })
  const [store] = useState(() => createStore<EditorState>(() => initial))
  const s = useStore(store)
  const tempSeq = useRef(0)
  const addSeq = useRef(0)
  const lastRev = useRef<TripRevision | null>(null)
  /** 保存进行中收到的服务端版本：保存完再处理 */
  const pendingServer = useRef<TripDetail | null>(null)

  const nextTempId = useCallback(() => -++tempSeq.current, [])
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: key, exact: true }), [qc, key])

  /* ---------------- 与服务端的版本对齐 ---------------- */

  const init = useCallback(
    (R: TripDetail) => {
      const stored = meId ? loadStoredDraft(meId, tripId) : null
      let restore: StoredDraft | null = null
      if (stored) {
        if (diffPlan(stored.base, stored.draft).length) restore = stored
        else clearStoredDraft(meId, tripId)
        tempSeq.current = Math.max(tempSeq.current, stored.nextTemp)
      }
      store.setState({ base: R, draft: R, restore })
    },
    [meId, tripId, store],
  )

  const reconcile = useCallback(
    (R: TripDetail) => {
      const st = store.getState()
      if (!st.base || !st.draft) return init(R)
      if (st.saving) {
        pendingServer.current = R
        return
      }
      const B = st.base
      if (R === B || R.revision < B.revision) return
      if (R.revision === B.revision) {
        // 同一个版本（点赞数这类不改变版本号的字段）：只更新计划之外的字段
        store.setState({ base: R, draft: st.draft === B ? R : merge3(B, st.draft, R) })
        return
      }
      const pn = poolNameOf(R)
      const mine = diffPlan(B, st.draft, pn)
      const theirs = diffPlan(B, R, pn)
      const rev = lastRev.current && lastRev.current.revision >= R.revision ? lastRev.current : null
      if (!mine.length) {
        // 没有未保存的修改：直接换成新版本
        const shown = theirs.filter((c) => !c.soft)
        const by = rev?.updated_by
        store.setState({
          base: R,
          draft: R,
          incoming: null,
          notice: null,
          synced: shown.length && by && by.id !== meId ? { by, text: shown[0].text, count: shown.length, at: Date.now() } : st.synced,
        })
        return
      }
      if (!blockingChanges(mine, theirs).length) {
        // 只是打卡、照片、自己立即生效的修改：合进草稿
        store.setState({ base: R, draft: merge3(B, st.draft, R), incoming: null, notice: null })
        return
      }
      const notice = { by: rev?.updated_by ?? null, at: rev?.updated_at ?? R.updated_at, revision: R.revision }
      // 对比窗口开着时又有新版本：对比的内容也换成最新的
      store.setState({ incoming: R, notice, conflict: st.conflict ? { ...st.conflict, remote: R, by: notice.by ?? st.conflict.by, at: notice.at } : null })
    },
    [store, init, meId],
  )

  useEffect(() => {
    if (query.data) reconcile(query.data)
  }, [query.data, reconcile])

  /* ---------------- 正在编辑的心跳、版本号轮询 ---------------- */

  const canEdit = !!query.data?.can_edit
  useEffect(() => {
    if (!tripId || !canEdit || !meId) return
    const leave = pendingLeave.get(tripId)
    if (leave) {
      clearTimeout(leave)
      pendingLeave.delete(tripId)
    }
    let beating = true
    const onRev = (r: TripRevision) => {
      lastRev.current = r
      const st = store.getState()
      const others = r.editors.filter((e) => e.user.id !== meId)
      const sig = (l: TripEditor[]) => l.map((e) => `${e.user.id}:${e.since}:${e.user.avatar_url}`).join()
      if (sig(others) !== sig(st.editors)) store.setState({ editors: others })
      // 横幅上还不知道是谁改的：补上
      if (st.notice && st.notice.revision === r.revision && !st.notice.by && r.updated_by)
        store.setState({ notice: { ...st.notice, by: r.updated_by, at: r.updated_at } })
      const known = Math.max(qc.getQueryData<TripDetail>(key)?.revision ?? 0, st.base?.revision ?? 0)
      if (r.revision > known && !st.saving) void qc.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false })
    }
    const beat = () => {
      if (!beating) return
      api.trips
        .editing(tripId, true)
        .then(onRev)
        .catch((e) => {
          // 不是已接受邀请的成员（如管理员）：不再发心跳，版本号照常轮询
          if (e instanceof ApiError && (e.status === 403 || e.status === 404)) beating = false
        })
    }
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      api.trips
        .revision(tripId)
        .then(onRev)
        .catch(() => {})
    }
    beat()
    const hb = setInterval(beat, HEARTBEAT_MS)
    const pt = setInterval(poll, POLL_MS)
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      beat()
      poll()
    }
    const onHide = () => void api.trips.editing(tripId, false).catch(() => {})
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(hb)
      clearInterval(pt)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onHide)
      if (beating)
        pendingLeave.set(
          tripId,
          setTimeout(() => {
            pendingLeave.delete(tripId)
            onHide()
          }, 400),
        )
    }
  }, [tripId, canEdit, meId, qc, key, store])

  /*
   * 规划中的旅程打开时，把服务端的顺序（seq）整理成按天的规范顺序：服务端的计划路线、下一站推荐按 seq 走，旧数据或别处加进来的
   * 点可能是乱的。没有别人在编辑时悄悄保存一次（只调整顺序、不改内容，别人的草稿也能直接合并）；冲突就算了，下次保存也会按规范顺序提交
   */
  const normalizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const normalized = useRef(false)
  useEffect(() => {
    const B = s.base
    if (normalized.current || !B || B !== query.data || !query.isFetchedAfterMount || B.phase !== 'planning' || !B.can_edit || s.restore) return
    const want = canonicalOrder(groupPlan(B.waypoints, B.days)).map((w) => w.id)
    if (want.join() === [...B.waypoints].sort(bySeq).map((w) => w.id).join()) return
    normalized.current = true
    normalizeTimer.current = setTimeout(async () => {
      normalizeTimer.current = null
      const cur = store.getState()
      if (cur.saving || cur.editors.length || cur.base?.revision !== B.revision) return
      try {
        const r = await api.trips.savePlan(tripId, { base_revision: B.revision, waypoints: want.map((id) => ({ id, client_key: `w${id}` })) })
        const now = store.getState()
        if (!now.base || !now.draft || now.base.revision !== B.revision || now.saving) return
        store.setState({ base: r.trip, draft: now.draft === now.base ? r.trip : merge3(now.base, now.draft, r.trip) })
        qc.setQueryData(key, r.trip)
      } catch {
        /* 别人刚改过、网络不好：不影响编辑 */
      }
    }, 1500)
    return () => {
      if (normalizeTimer.current) {
        clearTimeout(normalizeTimer.current)
        normalizeTimer.current = null
        normalized.current = false
      }
    }
  }, [s.base, s.restore, query.data, query.isFetchedAfterMount, store, tripId, qc, key])

  /* ---------------- 草稿 ---------------- */

  const pn = poolNameOf(s.draft)
  const changes = useMemo<PlanChange[]>(() => (s.base && s.draft ? diffPlan(s.base, s.draft, pn) : []), [s.base, s.draft, pn])
  const dirty = changes.length > 0

  // 暂存在本机：页面意外关闭（刷新、崩溃、没电）后可以恢复；保存或放弃后清掉。询问是否恢复期间不覆盖原来的
  const persist = useRef(() => {})
  persist.current = () => {
    const st = store.getState()
    if (!meId || !st.base || !st.draft || st.restore) return
    if (diffPlan(st.base, st.draft).length) storeDraft(meId, tripId, { base: st.base, draft: st.draft, nextTemp: tempSeq.current })
    else clearStoredDraft(meId, tripId)
  }
  useEffect(() => {
    const h = setTimeout(() => persist.current(), 300)
    return () => clearTimeout(h)
  }, [s.base, s.draft, s.restore])
  useEffect(() => {
    const flush = () => persist.current()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  /** 改草稿：fn 返回 null 表示不改 */
  const mutate = useCallback(
    (fn: (t: TripDetail) => TripDetail | null): boolean => {
      const st = store.getState()
      if (!st.draft || !st.base) return false
      const next = fn(st.draft)
      if (!next || next === st.draft) return false
      // 改回了和基础版本一样、又有别人的新版本在等：直接换成新版本
      if (st.incoming && !diffPlan(st.base, next).length) {
        store.setState({ base: st.incoming, draft: st.incoming, incoming: null, notice: null, errorId: null })
        return true
      }
      store.setState({ draft: next, errorId: null })
      return true
    },
    [store],
  )

  /** 基础版本和草稿一起改（立即生效的修改：服务端已经是这样了） */
  const applyBoth = useCallback(
    (fn: (t: TripDetail) => TripDetail) =>
      store.setState((st) => ({ base: st.base && fn(st.base), draft: st.draft && fn(st.draft) })),
    [store],
  )

  const markBusy = useCallback(
    (ids: number[], d: 1 | -1) =>
      store.setState((st) => {
        const n = new Map(st.busy)
        for (const id of ids) {
          const v = (n.get(id) ?? 0) + d
          if (v > 0) n.set(id, v)
          else n.delete(id)
        }
        return { busy: n }
      }),
    [store],
  )

  /** 立即调用接口（打卡记录、补记）：进行中禁用这一行；失败时提示原因 */
  const runNow = useCallback(
    async (ids: number[], fn: () => Promise<unknown>): Promise<boolean> => {
      if (ids.some((id) => store.getState().busy.has(id))) return false
      markBusy(ids, 1)
      try {
        await fn()
        return true
      } catch (e) {
        toast.error(errorMessage(e))
        return false
      } finally {
        markBusy(ids, -1)
      }
    },
    [store, markBusy],
  )

  /* ---------------- 地点 ---------------- */

  /** 补记已去过的地点（计划外的打卡）：立即保存，刷新后合进草稿 */
  const addVisited = useCallback(
    (input: WaypointInput, day: number, flags: WaypointInput): Promise<Waypoint | null> => {
      const k = ++addSeq.current
      store.setState((st) => ({ adding: [...st.adding, { key: k, name: input.name || input.address || '新地点', day }] }))
      return api.waypoints
        .create(tripId, { ...flags, ...input, kind: 'stop', day })
        .then(async (w) => {
          await qc.refetchQueries({ queryKey: key, exact: true })
          return w
        })
        .catch((e) => {
          toast.error(errorMessage(e))
          return null
        })
        .finally(() => store.setState((st) => ({ adding: st.adding.filter((a) => a.key !== k) })))
    },
    [store, tripId, qc, key],
  )

  /** 加到第 day 天的最后（0：「想去」）。计划外（补记已去过的地点）立即保存，其余只改草稿 */
  const addStop = useCallback(
    (input: WaypointInput, day: number, flags: WaypointInput = { planned: true, status: 'todo' }): Promise<Waypoint | null> => {
      const st = store.getState()
      if (!st.draft) return Promise.resolve(null)
      if (flags.planned === false) return addVisited(input, day, flags)
      const w = newWaypoint(st.draft, nextTempId(), input, day, 'stop')
      mutate((t) => addStopOp(t, w))
      return Promise.resolve(w)
    },
    [store, addVisited, nextTempId, mutate],
  )

  /**
   * 修改地点：计划的字段改草稿（换天时放到那天的最后；住宿换到另一晚）；打卡状态、到达时间属于打卡记录，立即保存。
   * 返回 false：没有改成（如那一晚已有住宿）
   */
  const update = useCallback(
    async (w: Waypoint, patch: WaypointInput): Promise<boolean> => {
      if (!store.getState().draft) return false
      const { status, arrived_at, day, planned: _p, seq: _s, coord_type: _c, ...plan } = patch
      void _p
      void _s
      void _c
      const statusChanged = status !== undefined && status !== w.status
      const arrivedChanged = arrived_at !== undefined && !sameMinute(arrived_at, w.arrived_at)
      let ok = true
      if ((statusChanged || arrivedChanged) && !isNew(w)) {
        ok = await runNow([w.id], async () => {
          const nw = await api.waypoints.update(w.id, {
            ...(statusChanged ? { status } : {}),
            ...(arrivedChanged ? { arrived_at } : {}),
          })
          const p = { status: nw.status, arrived_at: nw.arrived_at }
          applyBoth((t) => ({ ...t, waypoints: t.waypoints.map((x) => (x.id === w.id ? { ...x, ...p } : x)) }))
          void invalidate()
        })
      }
      const changed = mutate((t) => {
        let next = patchWaypoint(t, w.id, plan)
        if (day !== undefined && day !== w.day) {
          if (isLodging(w)) {
            const m = moveLodging(next, w.id, day)
            if (!m) {
              toast.error(`${day === 0 ? '出发前一晚' : `第 ${day} 晚`}已有住宿，请先清除原来的住宿`)
              ok = false
              return null
            }
            next = m
          } else next = placeInDay(next, w.id, day)
        }
        return next
      })
      void changed
      return ok
    },
    [store, runNow, applyBoth, invalidate, mutate],
  )

  /** 拖动地图上的标记微调位置 */
  const move = useCallback((w: Waypoint, p: LngLat) => void update(w, { lng: p[0], lat: p[1] }), [update])

  /**
   * 删除：计划里的点从草稿里去掉（undo：提示条上给「撤销」）；有打卡记录的点（计划外的打卡、已到达、有照片）
   * 保存计划不会删除它们，确认后立即删除（不能撤销；confirmed：调用方已经问过）
   */
  const remove = useCallback(
    async (w: Waypoint, opts: { undo?: boolean; confirmed?: boolean } = {}) => {
      const st = store.getState()
      if (!st.draft) return
      if (!isNew(w) && hasHistory(st.draft, w)) {
        if (st.busy.has(w.id)) return
        if (!opts.confirmed) {
          const photos = st.draft.photos.filter((p) => p.waypoint_id === w.id).length
          const ok = await confirmDialog({
            title: `删除打卡记录${label(w)}？`,
            desc: `这是已经去过的地点：会立即删除，不能撤销（不用再点保存）。到达时间、备注和评价会一起删除${photos ? `，关联的 ${photos} 张照片会保留（取消关联）` : ''}。`,
            danger: true,
            okText: '删除',
          })
          if (!ok) return
        }
        const cur = store.getState()
        if (!cur.draft || cur.busy.has(w.id) || !cur.draft.waypoints.some((x) => x.id === w.id)) return
        const inBase = cur.base?.waypoints.find((x) => x.id === w.id)
        applyBoth((t) => removeWaypoint(t, w.id))
        const ok = await runNow([w.id], () => api.trips.removeWaypoint(tripId, w.id))
        if (ok) void invalidate()
        else
          store.setState((cur) => ({
            base: cur.base && inBase ? restoreWaypoint(cur.base, inBase) : cur.base,
            draft: cur.draft ? restoreWaypoint(cur.draft, w) : cur.draft,
          }))
        return
      }
      if (!mutate((t) => removeWaypoint(t, w.id))) return
      if (opts.undo)
        toast(isLodging(w) ? `已清除住宿${label(w)}` : `已删除${label(w)}`, {
          description: '保存后生效',
          action: {
            label: '撤销',
            onClick: () =>
              void mutate((t) => {
                // 删除已经保存了（服务端没有这个点了）：按原来的字段作为新地点加回来
                const saved = isNew(w) || !!store.getState().base?.waypoints.some((x) => x.id === w.id)
                return restoreWaypoint(t, saved ? w : { ...w, id: nextTempId(), place_id: null })
              }),
          },
        })
    },
    [store, applyBoth, runNow, tripId, invalidate, mutate, nextTempId],
  )

  /**
   * 清除住宿（住宿行的 ×、同一晚多出来的住宿）：有打卡记录的住宿（到过、有照片）不删除，改为那一天的游玩点
   * （草稿里，保存后生效；出发前一晚的改到「想去」），打卡记录都在，想删再从那一行删；其余从草稿里去掉，可以撤销
   */
  const clearLodging = useCallback(
    (w: Waypoint) => {
      const st = store.getState()
      if (!st.draft) return
      if (isNew(w) || !hasHistory(st.draft, w)) return void remove(w, { undo: true })
      const day = w.day
      if (!mutate((t) => placeInDay({ ...t, waypoints: t.waypoints.map((x) => (x.id === w.id ? { ...x, kind: 'stop' as const } : x)) }, w.id, day)))
        return
      const where = day > 0 ? `第 ${day} 天的地点` : `「${poolNameOf(st.draft)}」`
      toast(`已清除住宿${label(w)}`, {
        description: `它有打卡记录，没有删除，改为${where}（保存后生效）`,
        action: {
          label: '撤销',
          onClick: () =>
            void mutate((t) => {
              const cur = t.waypoints.find((x) => x.id === w.id)
              if (!cur || isLodging(cur) || t.waypoints.some((x) => x.id !== w.id && isLodging(x) && x.day === day)) return null
              return makeLodgingOp(t, w.id, day)
            }),
        },
      })
    },
    [store, remove, mutate],
  )

  /** 移到另一天（0：「想去」），index 为在那天游玩点中的位置（缺省放在最后） */
  const moveToDay = useCallback((w: Waypoint, day: number, index?: number) => void mutate((t) => placeInDay(t, w.id, day, index)), [mutate])

  /** 调整第 day 天（0：「想去」）的先后顺序 */
  const reorder = useCallback(
    (day: number, orderedIds: number[]) => void mutate((t) => ({ ...t, waypoints: renumber(t.waypoints, t.days, day, orderedIds) })),
    [mutate],
  )

  /* ---------------- 住宿 ---------------- */

  /** 设置第 night 晚（0 为出发前一晚）的住宿；nights 连住几晚；这几晚已有住宿时替换。返回第 night 晚新的住宿（草稿里的） */
  const setLodging = useCallback(
    (night: number, input: WaypointInput, nights = 1): Waypoint | null => {
      let created: Waypoint | null = null
      mutate((t) => {
        const next = setLodgingOp(t, night, input, nights, nextTempId)
        const had = new Set(t.waypoints.map((w) => w.id))
        created = next.waypoints.find((w) => !had.has(w.id) && isLodging(w) && w.day === night) ?? null
        return next
      })
      return created
    },
    [mutate, nextTempId],
  )

  /** 「同前一晚」：沿用另一个点（前一晚的住宿）的酒店 */
  const copyLodging = useCallback((night: number, from: Waypoint) => setLodging(night, lodgingInputFrom(from)), [setLodging])

  /** 把一个游玩点（如「想去」里的酒店）改成第 night 晚的住宿 */
  const makeLodging = useCallback((w: Waypoint, night: number) => void mutate((t) => makeLodgingOp(t, w.id, night)), [mutate])

  /* ---------------- 旅程 ---------------- */

  /** 规划的天数：减少时被去掉的那几天的游玩点移到「想去」，多出来的住宿放回「想去」或去掉（同服务端） */
  const setDays = useCallback((n: number) => void mutate((t) => setDaysOp(t, n)), [mutate])

  const setTravelMode = useCallback((m: TravelMode) => void mutate((t) => (t.travel_mode === m ? null : { ...t, travel_mode: m })), [mutate])

  /** 旅程信息（标题、日期、状态、可见性、游记…） */
  const setInfo = useCallback((patch: Partial<Pick<TripDetail, TripField>>) => void mutate((t) => setTripFields(t, patch)), [mutate])

  /** 一键排路线的方案预览：服务端按已保存的计划计算（有未保存的地点修改时要先保存） */
  const previewArrangement = useCallback((input: ArrangeInput) => api.trips.arrange(tripId, { ...input, apply: false }), [tripId])

  /** 采用方案：改草稿（天和顺序；出行方式不变），保存后生效 */
  const applyArrangement = useCallback((r: ArrangeResult) => void mutate((t) => applyArrangementOp(t, r)), [mutate])

  /** 放弃全部未保存的修改（有别人的新版本时直接换成新版本）；还没决定要不要恢复的上次的草稿留着 */
  const discard = useCallback(() => {
    const st = store.getState()
    const next = st.incoming ?? st.base
    if (!next) return
    store.setState({ base: next, draft: next, incoming: null, notice: null, conflict: null, saveError: null, errorId: null })
    if (meId && !st.restore) clearStoredDraft(meId, tripId)
  }, [store, meId, tripId])

  /* ---------------- 恢复上次没保存的草稿 ---------------- */

  const restoreDraft = useCallback(() => {
    const st = store.getState()
    const sd = st.restore
    if (!sd || !st.base) return
    const R = qc.getQueryData<TripDetail>(key) ?? st.base
    const hydrate = (t: TripDetail): TripDetail => ({ ...t, photos: R.photos })
    store.setState({ base: hydrate(sd.base), draft: hydrate(sd.draft), restore: null, restoreHidden: false })
    // 服务端可能已经是更新的版本：照常对齐（有冲突时出横幅）
    reconcile(R)
  }, [store, qc, key, reconcile])

  /** 「不用了」：丢掉上次的草稿（只有明确选了才丢） */
  const dropRestore = useCallback(() => {
    if (meId) clearStoredDraft(meId, tripId)
    store.setState({ restore: null, restoreHidden: false })
  }, [store, meId, tripId])
  /** 关掉询问的窗口（Esc、点背景）：草稿留着，之后还可以恢复 */
  const hideRestore = useCallback(() => store.setState({ restoreHidden: true }), [store])
  const showRestore = useCallback(() => store.setState({ restoreHidden: false }), [store])

  /* ---------------- 保存 ---------------- */

  const saveRef = useRef<(opts?: { force?: boolean; retried?: boolean }) => Promise<SaveResult>>(async () => ({ ok: false }))
  const save = useCallback(
    async (opts: { force?: boolean; retried?: boolean } = {}): Promise<SaveResult> => {
      const st = store.getState()
      if (!st.base || !st.draft || st.saving) return { ok: false }
      const B = st.base
      if (!diffPlan(B, st.draft).length && !opts.force) {
        // 没有要保存的修改（可能有别人的新版本在等：换成它）
        if (st.incoming) store.setState({ base: st.incoming, draft: st.incoming, incoming: null, notice: null })
        return { ok: true, idMap: new Map() }
      }
      if (!st.draft.title.trim()) {
        toast.error('请填写旅程的标题')
        return { ok: false }
      }
      // 覆盖时对照服务端的最新版本：对方改过的也改回草稿的样子；对方给打卡写的评价（自己没动过的）保留
      const ref = opts.force ? (st.conflict?.remote ?? st.incoming ?? B) : B
      const sent = opts.force ? keepTheirReviews(B, st.draft, ref) : st.draft
      const { body, order } = planPayload(ref, sent, { force: opts.force, baseRevision: B.revision, isOwner: sent.is_owner, base: B })

      /** 409：取服务端的最新版本。对方只是打卡、传照片：合并后再保存一次；否则打开冲突对比 */
      async function onConflict(data: PlanConflict): Promise<SaveResult> {
        let remote: TripDetail
        try {
          remote = await api.trips.get(tripId)
        } catch (e) {
          toast.error('行程已被别人修改，暂时取不到最新的版本', { description: errorMessage(e) })
          return { ok: false }
        }
        const cur = store.getState()
        if (!cur.base || !cur.draft) return { ok: false }
        const pnr = poolNameOf(remote)
        const mine = diffPlan(cur.base, cur.draft, pnr)
        const theirs = diffPlan(cur.base, remote, pnr)
        qc.setQueryData(key, remote)
        if (!opts.force && !opts.retried && !blockingChanges(mine, theirs).length) {
          store.setState({ base: remote, draft: merge3(cur.base, cur.draft, remote), incoming: null, notice: null })
          return saveRef.current({ retried: true })
        }
        store.setState({
          incoming: remote,
          notice: { by: data.updated_by, at: data.updated_at, revision: remote.revision },
          conflict: { remote, by: data.updated_by, at: data.updated_at, source: 'save' },
        })
        return { ok: false, conflict: true }
      }

      store.setState({ saving: true, saveError: null, errorId: null })
      try {
        const r = await api.trips.savePlan(tripId, body)
        const idMap = new Map<number, number>()
        for (const w of order) {
          const id = r.id_map[clientKey(w)]
          if (isNew(w) && id) idMap.set(w.id, id)
        }
        const now = store.getState().draft ?? sent
        // 保存途中又改了：把这些修改合到保存后的版本上
        const draft = now === st.draft ? r.trip : merge3(remapIds(sent, idMap), remapIds(now, idMap), r.trip)
        store.setState({ base: r.trip, draft, incoming: null, notice: null, conflict: null, saving: false, saveError: null })
        qc.setQueryData(key, r.trip)
        void invalidateTripLists(qc)
        // 还没决定要不要恢复的上次的草稿留着
        if (meId && draft === r.trip && !store.getState().restore) clearStoredDraft(meId, tripId)
        const keptIds = new Set(r.kept)
        return { ok: true, idMap, kept: B.waypoints.filter((w) => keptIds.has(w.id)) }
      } catch (e) {
        store.setState({ saving: false })
        const data = e instanceof ApiError ? (e.data as Record<string, unknown> | undefined) : undefined
        if (e instanceof ApiError && e.status === 409 && typeof data?.revision === 'number') return onConflict(data as unknown as PlanConflict)
        if (e instanceof ApiError && typeof data?.index === 'number') {
          // 某一项有错：说出是哪个地点，并选中它
          const w = order[data.index]
          const msg = errorMessage(e)
            .replace(/^第 \d+ 项：/, '')
            .replace(/（第 (\d+) 项）/, (_, n: string) => (order[Number(n) - 1] ? `（${label(order[Number(n) - 1])}）` : ''))
          store.setState({ errorId: w?.id ?? null })
          toast.error(w ? `${label(w)}：${msg}` : msg)
          return { ok: false }
        }
        const msg = errorMessage(e)
        store.setState({ saveError: msg })
        toast.error('没有保存成功', { description: `${msg}。修改都还在，可以再点一次「保存」` })
        return { ok: false }
      } finally {
        const p = pendingServer.current
        pendingServer.current = null
        if (p) reconcile(p)
      }
    },
    [store, tripId, qc, key, meId, reconcile],
  )
  saveRef.current = save

  /** 冲突：载入对方的版本（放弃我的修改） */
  const loadTheirs = useCallback(() => {
    const st = store.getState()
    const R = st.conflict?.remote ?? st.incoming
    if (!R) return
    store.setState({ base: R, draft: R, incoming: null, notice: null, conflict: null, saveError: null, errorId: null })
    qc.setQueryData(key, R)
    if (meId && !st.restore) clearStoredDraft(meId, tripId)
  }, [store, qc, key, meId, tripId])

  /** 冲突：用我的版本覆盖 */
  const overwrite = useCallback(() => save({ force: true }), [save])

  /** 横幅上的「查看」：提前打开对比 */
  const viewIncoming = useCallback(() => {
    const st = store.getState()
    if (st.incoming)
      store.setState({
        conflict: { remote: st.incoming, by: st.notice?.by ?? null, at: st.notice?.at ?? st.incoming.updated_at, source: 'banner' },
      })
  }, [store])
  const closeConflict = useCallback(() => store.setState({ conflict: null }), [store])
  const dismissNotice = useCallback(() => store.setState((st) => ({ noticeDismissed: st.notice?.revision ?? st.noticeDismissed })), [store])
  const clearSynced = useCallback(() => store.setState({ synced: null }), [store])

  const saveState: SaveState = s.saving ? 'saving' : s.saveError && dirty ? 'error' : dirty ? 'dirty' : 'saved'
  const structureDirty = changes.some((c) => c.kind !== 'trip' || c.field === 'days' || c.field === 'dates')

  return {
    key,
    query,
    /** 草稿（页面显示和编辑的都是它） */
    trip: s.draft,
    base: s.base,
    changes,
    dirty,
    /** 地点、天数有未保存的修改（一键排路线要先保存） */
    structureDirty,
    saveState,
    saving: s.saving,
    saveError: s.saveError,
    errorId: s.errorId,
    busy: s.busy,
    adding: s.adding,
    isBusy: (id: number) => s.busy.has(id),
    editors: s.editors,
    incoming: s.incoming,
    notice: s.notice && s.notice.revision > s.noticeDismissed ? s.notice : null,
    conflict: s.conflict,
    restore: s.restore,
    restoreHidden: s.restoreHidden,
    synced: s.synced,
    addStop,
    update,
    move,
    remove,
    clearLodging,
    moveToDay,
    reorder,
    setLodging,
    copyLodging,
    makeLodging,
    setDays,
    setTravelMode,
    setInfo,
    previewArrangement,
    applyArrangement,
    discard,
    save,
    loadTheirs,
    overwrite,
    viewIncoming,
    closeConflict,
    dismissNotice,
    clearSynced,
    restoreDraft,
    dropRestore,
    hideRestore,
    showRestore,
  }
}

/** 覆盖时：对方给打卡写的评价（有打卡记录的点、自己没改过的字段）保留，不当作计划改回去 */
function keepTheirReviews(B: TripDetail, L: TripDetail, R: TripDetail): TripDetail {
  const bm = new Map(B.waypoints.map((w) => [w.id, w]))
  const rm = new Map(R.waypoints.map((w) => [w.id, w]))
  const fields: WpField[] = ['note', 'verdict', 'rating', 'cost']
  return {
    ...L,
    waypoints: L.waypoints.map((l) => {
      const b = bm.get(l.id)
      const r = rm.get(l.id)
      if (!b || !r || !hasHistory(R, r)) return l
      let out = l
      for (const f of fields) {
        if (JSON.stringify(l[f]) === JSON.stringify(b[f]) && JSON.stringify(r[f]) !== JSON.stringify(l[f])) out = { ...out, [f]: r[f] }
      }
      return out
    }),
  }
}

export type PlanEditor = ReturnType<typeof usePlanEditor>

const Ctx = createContext<PlanEditor | null>(null)

export function PlanEditorProvider({ editor, children }: { editor: PlanEditor; children: ReactNode }) {
  return <Ctx.Provider value={editor}>{children}</Ctx.Provider>
}

export function usePlanEditorCtx(): PlanEditor {
  const e = useContext(Ctx)
  if (!e) throw new Error('usePlanEditorCtx 需要在 PlanEditorProvider 里使用')
  return e
}

/** 离开页面前还有未保存的修改时提醒（关闭标签页 / 刷新）；草稿也暂存在本机，意外关闭后可以恢复 */
export function useUnsavedWarning(active: boolean) {
  useEffect(() => {
    if (!active) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [active])
}
