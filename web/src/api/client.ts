import type { AuthResult } from './types'

const API_BASE = '/api/v1'
const STORAGE_KEY = 'triphub.tokens'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Tokens {
  access: string
  refresh: string
}

/** external 为 true 表示 token 来自其他标签页（登录 / 刷新 / 退出 / 切换账号） */
type TokensListener = (t: Tokens | null, external: boolean) => void

let tokens: Tokens | null = loadTokens()
const listeners = new Set<TokensListener>()

function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    return null
  }
}

export function getTokens() {
  return tokens
}

export function setTokens(t: Tokens | null) {
  tokens = t
  try {
    if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 隐私模式下可能不可用 */
  }
  listeners.forEach((l) => l(t, false))
}

/** 采用其他标签页写入的 token（只更新内存，不回写 localStorage） */
function adoptTokens(t: Tokens | null) {
  if (t?.access === tokens?.access && t?.refresh === tokens?.refresh) return
  tokens = t
  listeners.forEach((l) => l(t, true))
}

// 多个标签页共用同一份登录：其他标签页换新 token、登录或退出时同步到本页（storage 事件不会在写入的标签页触发）
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY || e.key === null) adoptTokens(loadTokens())
})

export function onTokensChange(fn: TokensListener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function applyAuthResult(r: AuthResult) {
  setTokens({ access: r.access_token, refresh: r.refresh_token })
}

type Query = Record<string, string | number | boolean | null | undefined>

// 通过分享链接访问「链接可见」的旅程时，后续请求需要携带分享码
const SHARE_KEY = 'triphub.share-codes'
const shareCodes: Record<string, string> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(SHARE_KEY) ?? '{}')
  } catch {
    return {}
  }
})()

export function rememberShareCode(tripId: number, code: string) {
  shareCodes[String(tripId)] = code
  try {
    sessionStorage.setItem(SHARE_KEY, JSON.stringify(shareCodes))
  } catch {
    /* 忽略 */
  }
}

/** 本会话中通过分享链接记住的分享码（非成员再次分享「链接可见」旅程时使用） */
export function rememberedShareCode(tripId: number): string | undefined {
  return shareCodes[String(tripId)]
}

function shareHeader(path: string): Record<string, string> {
  const m = path.match(/^\/trips\/(\d+)/)
  const code = m && shareCodes[m[1]]
  return code ? { 'X-Share-Code': code } : {}
}

export interface RequestOptions {
  query?: Query
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  /** 上传进度（仅 form 请求） */
  onProgress?: (ratio: number) => void
}

function buildUrl(path: string, query?: Query) {
  const url = new URL(API_BASE + path, window.location.origin)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  return url.pathname + url.search
}

let refreshing: Promise<boolean> | null = null

/**
 * 用 refresh token 换新 token。refresh token 只能用一次，而多个标签页共用同一份 token：
 * 用 Web Locks 让各标签页依次刷新，刷新前后都先看 localStorage 里是否已被其他标签页换新，
 * 避免用旧 token 刷新失败后把其他标签页刚换到的有效 token 清掉。
 */
function refreshTokens(): Promise<boolean> {
  const stale = tokens?.refresh
  if (!stale) return Promise.resolve(false)
  if (!refreshing) {
    const run = () => doRefresh(stale)
    // navigator.locks 仅在 HTTPS / localhost 下可用
    refreshing = ('locks' in navigator ? navigator.locks.request('triphub.refresh', run) : run())
      .catch(() => false) // 网络错误：保留 token，稍后再试
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

/** localStorage 里的 token 已被其他标签页换新时直接采用 */
function adoptIfRotated(stale: string): boolean {
  const s = loadTokens()
  if (!s || s.refresh === stale) return false
  adoptTokens(s)
  return true
}

async function doRefresh(stale: string): Promise<boolean> {
  if (adoptIfRotated(stale)) return true
  if (tokens?.refresh !== stale) return false // 本页已退出或换了账号
  const res = await fetch(API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: stale }),
  })
  if (res.ok) {
    const r = (await res.json()) as AuthResult
    if (tokens?.refresh !== stale) {
      // 刷新途中退出了登录或换了账号：作废刚拿到的 token，不写回
      fetch(API_BASE + '/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: r.refresh_token }),
      }).catch(() => {})
      return false
    }
    applyAuthResult(r)
    return true
  }
  // 5xx / 网关错误 / 限流：refresh token 可能仍然有效，保留登录
  if (res.status !== 400 && res.status !== 401 && res.status !== 403) return false
  // 可能是其他标签页先用掉了这个 refresh token
  if (adoptIfRotated(stale)) return true
  if (res.status === 401) {
    // 没有 Web Locks 时，其他标签页的刷新结果可能还在路上，稍等再看一次
    await new Promise((r) => setTimeout(r, 1500))
    if (adoptIfRotated(stale)) return true
  }
  // 仅当 refresh token 仍是当前值时才清除（避免并发登录被误清）
  if (tokens?.refresh === stale) setTokens(null)
  return false
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'internal'
  let message = `请求失败（${res.status}）`
  try {
    const data = await res.json()
    if (data?.error) {
      code = data.error.code ?? code
      message = data.error.message ?? message
    }
  } catch {
    /* 非 JSON 响应 */
  }
  if (res.status === 413 && code === 'internal') message = '文件太大了'
  if (res.status >= 502 && res.status <= 504) message = '服务器暂时无法访问，请稍后再试'
  return new ApiError(res.status, code, message)
}

function xhrUpload<T>(method: string, url: string, form: FormData, opts: RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    if (tokens?.access) xhr.setRequestHeader('Authorization', `Bearer ${tokens.access}`)
    for (const [k, v] of Object.entries(shareHeader(url.replace(API_BASE, '')))) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total)
    }
    xhr.onload = async () => {
      const res = new Response(xhr.responseText, { status: xhr.status })
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText ? JSON.parse(xhr.responseText) : ({} as T))
      else reject(await parseError(res))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', '网络连接失败'))
    opts.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(form)
  })
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const url = buildUrl(path, opts.query)

  if (opts.form && opts.onProgress) {
    try {
      return await xhrUpload<T>(method, url, opts.form, opts)
    } catch (e) {
      if (retry && e instanceof ApiError && e.status === 401 && (await refreshTokens())) {
        return request<T>(method, path, opts, false)
      }
      throw e
    }
  }

  const headers: Record<string, string> = { ...shareHeader(path) }
  const sentAccess = tokens?.access
  if (sentAccess) headers.Authorization = `Bearer ${sentAccess}`
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(url, { method, headers, body, signal: opts.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'network', '网络连接失败，请检查网络')
  }

  if (res.status === 401 && retry && sentAccess && !path.startsWith('/auth/')) {
    // 请求途中 token 已被其他请求或标签页换新：直接用新 token 重试，不再刷新一次
    if (tokens?.access && tokens.access !== sentAccess) return request<T>(method, path, opts, false)
    if (await refreshTokens()) return request<T>(method, path, opts, false)
    // refresh 失败且 token 已被清除：🔓 接口按 API.md 约定以游客身份重试一次（写操作都需要登录，只重试 GET）
    if (!tokens && method === 'GET') return request<T>(method, path, opts, false)
  }
  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return {} as T
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body === undefined ? {} : { body }),
  upload: <T>(path: string, form: FormData, onProgress?: (r: number) => void) =>
    request<T>('POST', path, { form, onProgress }),
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return '出错了，请稍后再试'
}

/** 资源不存在或无权查看（服务端对不可见的资源统一返回 404） */
export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404
