/**
 * 主题运行时：
 * - 偏好 { theme, mode: 'system' | 'light' | 'dark', modeChosen } 存在 localStorage（'triphub.theme'）；
 *   默认 { journal, light }：第一次打开是「手帐 · 纸页」，不看系统深浅色（跟随系统要在外观里主动选）。
 * - 用户没明确选过深浅色时（modeChosen = false），换主题会用该主题设计时的模式：暮色、夜航是深色，其余是浅色；
 *   一旦选过「跟随系统 / 浅色 / 深色」，换主题都保持这个选择。
 * - 生效的主题写在 <html data-theme data-mode>（首屏由 index.html 里的内联脚本先写好，避免闪一下，逻辑与 readPref 一致）；
 * - 「跟随系统」随 prefers-color-scheme 实时变化；多个标签页之间同步；
 * - 每次变化后在 window 上派发 'triphub:theme' 事件（地图等非 React 代码订阅），并更新 <meta name="theme-color">；
 * - 字体按主题懒加载：只引入当前主题的 @font-face（中文字体是 unicode-range 切片，只下载用到的字）。
 *   按文字宽度排版的组件（撑满整行的字标等）用 useTypeEpoch() 在字体到达、换主题后重新测量。
 */
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { DEFAULT_THEME, THEMES, isModePref, isThemeId, type Mode, type ModePref, type ThemeId } from './themes'

export const THEME_STORAGE_KEY = 'triphub.theme'
/** 主题或模式变化后派发在 window 上，detail 为 ThemeState */
export const THEME_EVENT = 'triphub:theme'

export interface ThemePref {
  theme: ThemeId
  mode: ModePref
  /** 用户是否明确选过深浅色；没选过时 mode 跟着主题走（该主题的 defaultMode），换主题时一起换 */
  modeChosen: boolean
}
export interface ResolvedTheme {
  theme: ThemeId
  mode: Mode
}
export interface ThemeState {
  pref: ThemePref
  resolved: ResolvedTheme
}

export const DEFAULT_PREF: ThemePref = { theme: DEFAULT_THEME, mode: THEMES[DEFAULT_THEME].defaultMode, modeChosen: false }

const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined'
const darkQuery = hasDOM && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** 读保存的偏好（与 index.html 首屏脚本的逻辑一致，改这里要同步改那里） */
export function readPref(): ThemePref {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null') as Partial<ThemePref> | null
    const theme = isThemeId(raw?.theme) ? raw.theme : DEFAULT_THEME
    // 早期版本没有 modeChosen：明确的浅色 / 深色算选过，'system'（当时的默认值）不算
    const chosen = (typeof raw?.modeChosen === 'boolean' ? raw.modeChosen : raw?.mode === 'light' || raw?.mode === 'dark') && isModePref(raw?.mode)
    return chosen ? { theme, mode: raw!.mode as ModePref, modeChosen: true } : { theme, mode: THEMES[theme].defaultMode, modeChosen: false }
  } catch {
    return { ...DEFAULT_PREF }
  }
}

function writePref(p: ThemePref) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式等：只在本次会话生效 */
  }
}

export const systemMode = (): Mode => (darkQuery?.matches ? 'dark' : 'light')

export const resolveTheme = (p: ThemePref): ResolvedTheme => ({ theme: p.theme, mode: p.mode === 'system' ? systemMode() : p.mode })

/** 选用某个主题后会显示哪个模式（没选过深浅色时是该主题的默认模式）；主题卡片、快捷菜单用它预告 */
export function modeForTheme(theme: ThemeId, pref: ThemePref = useThemeStore.getState().pref): Mode {
  if (!pref.modeChosen) return THEMES[theme].defaultMode
  return pref.mode === 'system' ? systemMode() : pref.mode
}

/** 当前生效的主题：读 <html> 上的属性（地图、海报等在渲染时调用） */
export function getResolvedTheme(): ResolvedTheme {
  if (!hasDOM) return resolveTheme(DEFAULT_PREF)
  const { theme, mode } = document.documentElement.dataset
  return isThemeId(theme) && (mode === 'light' || mode === 'dark') ? { theme, mode } : resolveTheme(readPref())
}

/* ---------------- 字体：每个主题一份 @font-face，用到时才引入 ---------------- */
const fontLoaders: Record<ThemeId, () => Promise<unknown>> = {
  journal: () => import('./fonts/journal.css'),
  camp: () => import('./fonts/camp.css'),
  coast: () => import('./fonts/coast.css'),
  dusk: () => import('./fonts/dusk.css'),
  voyage: () => import('./fonts/voyage.css'),
}
const fontJobs = new Map<ThemeId, Promise<void>>()

/** 引入主题的字体样式（幂等）；失败时下次再试 */
export function ensureThemeFonts(id: ThemeId): Promise<void> {
  let job = fontJobs.get(id)
  if (!job) {
    job = fontLoaders[id]().then(
      () => undefined,
      () => {
        fontJobs.delete(id)
      },
    )
    fontJobs.set(id, job)
  }
  return job
}

/* ---------------- 排版版本：字体到达或换了主题时加一 ---------------- */
// 字体是懒加载的：组件第一次测量文字宽度时，主题字体往往还没到（document.fonts.ready 也可能早就 resolve 了），
// 换主题后字宽也会变。按宽度排版的组件把 useTypeEpoch() 放进 effect 依赖，就会在这些时刻重新测量。
let typeEpoch = 0
const typeListeners = new Set<() => void>()
function bumpTypeEpoch() {
  typeEpoch += 1
  for (const l of typeListeners) l()
}
function subscribeTypeEpoch(cb: () => void) {
  typeListeners.add(cb)
  return () => {
    typeListeners.delete(cb)
  }
}
/** 字体加载完成、主题或深浅色变化时变化的计数（放进测量文字的 useLayoutEffect 依赖里） */
export function useTypeEpoch(): number {
  return useSyncExternalStore(subscribeTypeEpoch, () => typeEpoch, () => 0)
}

/* ---------------- 写到页面上 ---------------- */
function applyToDocument(r: ResolvedTheme) {
  const root = document.documentElement
  const changed = root.dataset.theme !== r.theme || root.dataset.mode !== r.mode
  if (changed) {
    // 切换的那一帧关掉过渡，两帧后恢复
    root.classList.add('th-switching')
    root.dataset.theme = r.theme
    root.dataset.mode = r.mode
    root.style.colorScheme = r.mode
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('th-switching')))
  }
  const paper = THEMES[r.theme].themeColor[r.mode]
  // 首屏脚本在 <html> 上写了底色（样式表到达前不闪白），切换时一并更新
  root.style.backgroundColor = paper
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', paper)
  // 字体样式到达后浏览器才开始下载字体文件，下载完会触发 document.fonts 的 loadingdone（见 initTheme）
  void ensureThemeFonts(r.theme).then(bumpTypeEpoch)
}

const initialPref = hasDOM ? readPref() : { ...DEFAULT_PREF }

/** 主题状态（zustand）：组件里用 useTheme() */
export const useThemeStore = create<ThemeState>(() => ({ pref: initialPref, resolved: resolveTheme(initialPref) }))

function sync(pref: ThemePref, persist: boolean) {
  if (persist) writePref(pref)
  const resolved = resolveTheme(pref)
  const prev = useThemeStore.getState().resolved
  const domChanged = hasDOM && (document.documentElement.dataset.theme !== resolved.theme || document.documentElement.dataset.mode !== resolved.mode)
  if (hasDOM) applyToDocument(resolved)
  useThemeStore.setState({ pref, resolved })
  if (hasDOM && (domChanged || prev.theme !== resolved.theme || prev.mode !== resolved.mode)) {
    window.dispatchEvent(new CustomEvent<ThemeState>(THEME_EVENT, { detail: { pref, resolved } }))
    bumpTypeEpoch()
  }
}

/**
 * 修改偏好并立即生效（会保存）。传了 mode 就算明确选过深浅色；
 * 只换主题且没选过深浅色时，模式跟着换成新主题的默认模式
 */
export function setThemePref(patch: Partial<ThemePref>) {
  const cur = useThemeStore.getState().pref
  const next: ThemePref = { ...cur, ...patch }
  if (patch.mode !== undefined && patch.modeChosen === undefined) next.modeChosen = true
  if (!next.modeChosen) next.mode = THEMES[next.theme].defaultMode
  sync(next, true)
}
export const setTheme = (theme: ThemeId) => setThemePref({ theme })
export const setMode = (mode: ModePref) => setThemePref({ mode })
/** 在浅色与深色之间切换（明确指定，不再跟随系统） */
export const toggleMode = () => setMode(useThemeStore.getState().resolved.mode === 'dark' ? 'light' : 'dark')

/** 非 React 代码订阅主题变化；返回取消订阅函数 */
export function onThemeChange(cb: (s: ThemeState) => void) {
  const h = (e: Event) => cb((e as CustomEvent<ThemeState>).detail)
  window.addEventListener(THEME_EVENT, h)
  return () => window.removeEventListener(THEME_EVENT, h)
}

/** 组件里读写主题 */
export function useTheme() {
  const pref = useThemeStore((s) => s.pref)
  const resolved = useThemeStore((s) => s.resolved)
  return { pref, resolved, theme: resolved.theme, mode: resolved.mode, meta: THEMES[resolved.theme], setTheme, setMode, setThemePref, toggleMode }
}

/**
 * 局部强制某个模式：把返回的属性展开到容器上，容器里的令牌就是该模式的数值。
 * 例：3D 夜景在浅色模式下仍用深色界面 <div {...useThemeScope('dark')}>
 */
export function useThemeScope(mode: Mode, theme?: ThemeId) {
  const current = useThemeStore((s) => s.resolved.theme)
  return { 'data-theme': theme ?? current, 'data-mode': mode } as const
}

let started = false
/** 启动：套用偏好（与首屏脚本结果一致时不闪）、加载字体、跟随系统深浅色、同步其他标签页 */
export function initTheme() {
  if (started || !hasDOM) return
  started = true
  sync(readPref(), false)
  const onSystem = () => {
    const { pref } = useThemeStore.getState()
    if (pref.modeChosen && pref.mode === 'system') sync(pref, false)
  }
  if (darkQuery?.addEventListener) darkQuery.addEventListener('change', onSystem)
  else darkQuery?.addListener?.(onSystem)
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) sync(readPref(), false)
  })
  // 懒加载的主题字体下载完成：按文字宽度排版的组件重新测量
  document.fonts?.addEventListener?.('loadingdone', bumpTypeEpoch)
}

initTheme()
