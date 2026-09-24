import { create } from 'zustand'
import { api } from '@/api'
import { applyAuthResult, getTokens, onTokensChange, setTokens } from '@/api/client'
import type { AuthResult, Me } from '@/api/types'

interface AuthState {
  user: Me | null
  /** 首次加载用户信息是否完成 */
  ready: boolean
  setUser: (u: Me | null) => void
  loginWith: (r: AuthResult) => void
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,
  setUser: (user) => set({ user }),
  loginWith: (r) => {
    applyAuthResult(r)
    set({ user: r.user, ready: true })
  },
  logout: async () => {
    const t = getTokens()
    setTokens(null)
    set({ user: null })
    if (t?.refresh) api.auth.logout(t.refresh).catch(() => {})
  },
  refreshMe: async () => {
    if (!getTokens()) {
      set({ user: null, ready: true })
      return
    }
    try {
      const user = await api.me.get()
      set({ user, ready: true })
    } catch {
      set({ ready: true })
    }
  },
}))

// token 被清除（如 refresh 失败）时同步登出
onTokensChange((t) => {
  if (!t) useAuth.setState({ user: null })
})

export const isAdmin = (u: Me | null | undefined) => u?.role === 'admin'
