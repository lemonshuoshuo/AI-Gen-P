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

let tokens: Tokens | null = loadTokens()
const listeners = new Set<(t: Tokens | null) => void>()

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
  listeners.forEach((l) => l(t))
}

export function onTokensChange(fn: (t: Tokens | null) => void) {
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

async function refreshTokens(): Promise<boolean> {
  if (!tokens?.refresh) return false
  if (!refreshing) {
    const refresh = tokens.refresh
    refreshing = fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // 仅当 refresh token 仍是当前值时才清除（避免并发登录被误清）
          if (tokens?.refresh === refresh) setTokens(null)
          return false
        }
        applyAuthResult((await res.json()) as AuthResult)
        return true
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
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
  if (tokens?.access) headers.Authorization = `Bearer ${tokens.access}`
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

  if (res.status === 401 && retry && tokens?.refresh && !path.startsWith('/auth/')) {
    if (await refreshTokens()) return request<T>(method, path, opts, false)
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
