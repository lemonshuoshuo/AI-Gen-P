// 离线待发队列：旅行模式下的打卡 / 跳过 / 拍照先存到本机（IndexedDB）再发送，
// 网络不好发不出去时保留，联网后按先后顺序补发（见 components/OutboxSync）。
// 每条记录的 id 同时作为 client_id 提交，重复提交时服务端按它去重，不会产生重复的打卡点或照片。
import { toast } from 'sonner'
import { api, ApiError, errorMessage } from '@/api'
import type { CoordType, Photo, Waypoint } from '@/api/types'

export interface CheckinBody {
  lng?: number
  lat?: number
  coord_type?: CoordType
  name?: string
  address?: string
  amap_id?: string
  category?: string
  waypoint_id?: number | null
  arrived_at?: string
}

export interface PhotoMeta {
  filename?: string
  lng?: number
  lat?: number
  coord_type?: CoordType
  taken_at?: string
  auto_waypoint?: boolean
}

interface ItemBase {
  /** 同时作为 client_id */
  id: string
  userId: number
  tripId: number
  createdAt: number
}
export type CheckinItem = ItemBase & { kind: 'checkin'; body: CheckinBody }
export type SkipItem = ItemBase & { kind: 'skip'; waypointId: number }
/** 照片存成 ArrayBuffer + 类型（Safari 往 IndexedDB 里存 Blob 有兼容问题） */
export type PhotoItem = ItemBase & { kind: 'photo'; data: ArrayBuffer; mime: string; meta: PhotoMeta }
export type OutboxItem = CheckinItem | SkipItem | PhotoItem

export interface CheckinResult {
  waypoint: Waypoint
  matched_plan: boolean
}
export interface PhotoResult {
  photo: Photo
  waypoint: Waypoint | null
  waypoint_created: boolean
}

/** 客户端幂等键（非 HTTPS 页面没有 crypto.randomUUID） */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---------------- 存储 ---------------- */
const DB_NAME = 'triphub'
const STORE = 'outbox'
/** IndexedDB 不可用（部分隐私模式）或写入失败时退回内存，至少本次打开期间还能补发 */
const memory = new Map<string, OutboxItem>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const db = await openDB()
    if (!db) throw new Error('IndexedDB 不可用')
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入失败'))
      })
    } catch (e) {
      // iOS 切到后台后连接可能被系统断开：重新打开再试一次
      if (attempt > 0) throw e
      db.close()
      dbPromise = null
    }
  }
}

const changeListeners = new Set<() => void>()
const sentListeners = new Set<(item: OutboxItem) => void>()

/** 队列有增减时通知 */
export function onOutboxChange(fn: () => void) {
  changeListeners.add(fn)
  return () => {
    changeListeners.delete(fn)
  }
}

/** 某条记录发送成功后通知 */
export function onOutboxSent(fn: (item: OutboxItem) => void) {
  sentListeners.add(fn)
  return () => {
    sentListeners.delete(fn)
  }
}

export async function enqueue(item: OutboxItem) {
  try {
    await run('readwrite', (s) => s.put(item))
  } catch {
    memory.set(item.id, item)
  }
  changeListeners.forEach((l) => l())
}

async function remove(id: string) {
  memory.delete(id)
  try {
    await run('readwrite', (s) => s.delete(id))
  } catch {
    /* 忽略：残留的记录重发时服务端会按 client_id 去重 */
  }
  changeListeners.forEach((l) => l())
}

/** 某个用户（某个旅程）待发送的记录，按创建先后排序 */
export async function listOutbox(userId: number, tripId?: number): Promise<OutboxItem[]> {
  let stored: OutboxItem[] = []
  try {
    stored = await run('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>)
  } catch {
    /* 忽略 */
  }
  return [...stored, ...memory.values()]
    .filter((x) => x.userId === userId && (tripId == null || x.tripId === tripId))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 队列里是否还有记录（不读取照片内容） */
export async function hasPending(): Promise<boolean> {
  if (memory.size) return true
  try {
    return (await run('readonly', (s) => s.count())) > 0
  } catch {
    return false
  }
}

/* ---------------- 发送 ---------------- */

/** 网络问题、服务器暂时不可用或需要重新登录：保留在本机稍后重发；其余 4xx 重发也不会成功 */
export function isRetryable(e: unknown) {
  if (!(e instanceof ApiError)) return true
  return e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500
}

function send(item: OutboxItem): Promise<unknown> {
  switch (item.kind) {
    case 'checkin':
      return api.trips.checkin(item.tripId, { ...item.body, client_id: item.id })
    case 'skip':
      return api.waypoints.skip(item.waypointId)
    case 'photo':
      return api.photos.upload(item.tripId, new Blob([item.data], { type: item.mime }), { ...item.meta, client_id: item.id })
  }
}

const inflight = new Map<string, Promise<unknown>>()
/** 本次打开期间已发送或已丢弃的记录，补发时跳过，避免重复提交 */
const settled = new Set<string>()

/**
 * 发送一条记录，成功后移出队列；同一条记录正在发送时复用那次请求。
 * before 在发送前执行（此时记录已算作发送中，后台补发不会同时再发一次）。
 */
export function sendItem(item: CheckinItem, before?: () => Promise<unknown>): Promise<CheckinResult>
export function sendItem(item: SkipItem, before?: () => Promise<unknown>): Promise<Waypoint>
export function sendItem(item: PhotoItem, before?: () => Promise<unknown>): Promise<PhotoResult>
export function sendItem(item: OutboxItem, before?: () => Promise<unknown>): Promise<unknown>
export function sendItem(item: OutboxItem, before?: () => Promise<unknown>): Promise<unknown> {
  let p = inflight.get(item.id)
  if (!p) {
    p = (before ? before().then(() => send(item)) : send(item))
      .then(async (r) => {
        settled.add(item.id)
        await remove(item.id)
        sentListeners.forEach((l) => l(item))
        return r
      })
      .finally(() => inflight.delete(item.id))
    inflight.set(item.id, p)
  }
  return p
}

function savePhoto(item: PhotoItem) {
  const url = URL.createObjectURL(new Blob([item.data], { type: item.mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = `triphub-${item.createdAt}.jpg`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 服务端明确拒绝（4xx）的记录重发也不会成功：移出队列并提示；照片不能悄悄丢掉，给一个保存到手机的机会 */
export async function discard(item: OutboxItem, e: unknown) {
  settled.add(item.id)
  await remove(item.id)
  const msg = errorMessage(e)
  if (item.kind === 'photo') {
    toast.error(`照片上传失败：${msg}`, {
      duration: Infinity,
      action: { label: '保存到手机', onClick: () => savePhoto(item) },
    })
  } else toast.error(item.kind === 'skip' ? `跳过没有保存：${msg}` : `打卡没有保存：${msg}`)
}

let flushing: Promise<void> | null = null

/** 按先后顺序补发该用户的记录；遇到网络问题就停下（保持顺序），稍后再试 */
export function flushOutbox(userId: number): Promise<void> {
  flushing ??= (async () => {
    for (const item of await listOutbox(userId)) {
      if (settled.has(item.id)) continue
      // 页面正在发送的那一条：等它的结果，失败时的提示 / 丢弃由页面处理
      const running = inflight.get(item.id)
      try {
        await (running ?? sendItem(item))
      } catch (e) {
        if (isRetryable(e)) break
        if (!running) await discard(item, e)
      }
    }
  })().finally(() => {
    flushing = null
  })
  return flushing
}
