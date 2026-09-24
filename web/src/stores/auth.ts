import { create } from 'zustand'
import { api } from '@/api'
import { applyAuthResult, getTokens, onTokensChange, setTokens } from '@/api/client'
import type { AuthResult, Me } from '@/api/types'
import { clearUserCache } from '@/lib/queryClient'

interface AuthState {
  user: Me | null
  /** 首次加载用户信息是否完成 */
  ready: boolean
  setUser: (u: Me | null) => void
  loginWith: (r: AuthResult) => void
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
  /** 距上次获取超过 maxAge 毫秒时才刷新（切换页面、切回前台时调用） */
  refreshMeIfStale: (maxAge?: number) => void
}

// 缓存上次的用户信息：网络不好时打开页面仍保持登录状态，不会被踢到登录页
const ME_KEY = 'triphub.me'

function loadMe(): Me | null {
  try {
    const raw = localStorage.getItem(ME_KEY)
    return raw ? (JSON.parse(raw) as Me) : null
  } catch {
    return null
  }
}

function saveMe(u: Me | null) {
  try {
    if (u) localStorage.setItem(ME_KEY, JSON.stringify(u))
    else localStorage.removeItem(ME_KEY)
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

let retryOnOnline = false
// 同一时间只发一个 /me 请求；lastFetched 用于 refreshMeIfStale 节流
let inflight: Promise<void> | null = null
let lastFetched = 0
// 登录、退出、其他标签页切换账号时加一：之前发出、还没返回的 /me 结果作废
let generation = 0

function resetMeRequest() {
  generation++
  inflight = null
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  setUser: (user) => {
    saveMe(user)
    set({ user })
  },
  loginWith: (r) => {
    // 丢掉上一个账号（或游客视角）缓存的数据，如私密旅程、通知、旅程的 can_edit / liked
    clearUserCache()
    resetMeRequest()
    lastFetched = Date.now()
    applyAuthResult(r)
    saveMe(r.user)
    set({ user: r.user, ready: true })
  },
  logout: async () => {
    const t = getTokens()
    setTokens(null)
    saveMe(null)
    set({ user: null })
    if (t?.refresh) api.auth.logout(t.refresh).catch(() => {})
  },
  refreshMe: () => {
    if (inflight) return inflight
    const gen = generation
    const p = (async () => {
      if (!getTokens()) {
        set({ user: null, ready: true })
        return
      }
      try {
        const user = await api.me.get()
        // 请求途中退出或切换了账号：丢弃结果，不把刚退出的用户恢复回来
        if (gen !== generation || !getTokens()) {
          set({ ready: true })
          return
        }
        lastFetched = Date.now()
        // 其他标签页直接换成了另一个账号：清掉上一个账号的缓存数据
        const prev = get().user
        if (prev && prev.id !== user.id) clearUserCache()
        saveMe(user)
        set({ user, ready: true })
      } catch {
        if (gen !== generation) {
          set({ ready: true })
          return
        }
        if (!getTokens()) {
          set({ user: null, ready: true })
          return
        }
        // 网络不好或服务器暂时不可用（token 仍在）：先用缓存的用户信息，联网后再刷新
        set({ user: get().user ?? loadMe(), ready: true })
        if (!retryOnOnline) {
          retryOnOnline = true
          window.addEventListener(
            'online',
            () => {
              retryOnOnline = false
              void get().refreshMe()
            },
            { once: true },
          )
        }
      }
    })().finally(() => {
      if (inflight === p) inflight = null
    })
    inflight = p
    return p
  },
  refreshMeIfStale: (maxAge = 30_000) => {
    if (getTokens() && Date.now() - lastFetched > maxAge) void get().refreshMe()
  },
}))

// token 被清除（如 refresh 失败、在其他标签页退出）时同步登出，并清空缓存的数据；
// 其他标签页登录、换新 token 或切换账号时重新获取用户信息
onTokensChange((t, external) => {
  if (!t) {
    resetMeRequest()
    saveMe(null)
    useAuth.setState({ user: null })
    clearUserCache()
  } else if (external) {
    resetMeRequest()
    // 游客视角缓存的数据（如旅程的 can_edit）作废；换了账号由 refreshMe 清空
    if (!useAuth.getState().user) clearUserCache()
    void useAuth.getState().refreshMe()
  }
})

// 切回前台时按需刷新：情侣绑定、等级经验、存储空间可能已在别处改变
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') useAuth.getState().refreshMeIfStale()
})

export const isAdmin = (u: Me | null | undefined) => u?.role === 'admin'
