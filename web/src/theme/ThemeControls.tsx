// 主题切换界面：顶栏的快捷切换、账户菜单里的一行、设置页「外观」的主题卡片
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { CheckBadge, Menu, OptionGroup, Segmented, selectedClass } from '@/components/ui'
import { cn } from '@/lib/cn'
import { ensureThemeFonts, modeForTheme, useTheme } from './runtime'
import { THEMES, THEME_IDS, type Mode, type ModePref, type ThemeId } from './themes'

const modeOptions: { value: ModePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

const modeWord = (m: Mode) => (m === 'dark' ? '深色' : '浅色')

/** 主题色块：该主题在某个模式下的纸色 + 实心强调色（用 data-theme 局部套用主题，颜色与页面完全一致） */
export function ThemeSwatch({ theme, mode, size = 22, className }: { theme: ThemeId; mode: Mode; size?: number; className?: string }) {
  return (
    <span
      data-theme={theme}
      data-mode={mode}
      aria-hidden
      className={cn('relative inline-block shrink-0 overflow-hidden rounded-full bg-paper ring-1 ring-ink-300', className)}
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-y-0 right-0 w-1/2 bg-brand-fill" />
      <span className="absolute right-[22%] bottom-[22%] size-[26%] rounded-full bg-gold" />
    </span>
  )
}

/** 模式三选一：跟随系统 / 浅色 / 深色（没明确选过时，亮起的是当前主题的默认模式） */
export function ModeSwitch({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  const { pref, setMode } = useTheme()
  return (
    <Segmented<ModePref>
      label="深浅色"
      size={size}
      value={pref.mode}
      onChange={setMode}
      className={className}
      options={modeOptions.map((o) => ({
        value: o.value,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <o.icon className="size-3.5" strokeWidth={1.75} aria-hidden />
            {o.label}
          </span>
        ),
      }))}
    />
  )
}

/** 主题列表（一行一个：色块 + 名称 + 选用后的模式名），选中项用统一的行选中样式 */
function ThemeList({ onPick }: { onPick?: () => void }) {
  const { pref, mode, setTheme } = useTheme()
  return (
    <div role="radiogroup" aria-label="主题" className="space-y-0.5">
      {THEME_IDS.map((id) => {
        const t = THEMES[id]
        const on = pref.theme === id
        // 当前主题显示正在用的模式；其他主题显示选用后会是哪个模式（没选过深浅色时暮色、夜航是深色）
        const m = on ? mode : modeForTheme(id, pref)
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              setTheme(id)
              onPick?.()
            }}
            // 悬停底色只给未选中的行：选中行的强调色底纹不能在指针下被换掉
            className={selectedClass(on, 'row', cn('flex w-full items-center gap-3 rounded-lg py-2 pr-3 pl-3.5 text-left', !on && 'hover:bg-ink-100'))}
          >
            <ThemeSwatch theme={id} mode={m} />
            <span className="min-w-0 flex-1">
              <span className="th-sel-title block text-[13.5px] text-ink-900">
                {t.name} <span className="text-xs text-ink-500">{t.nameEn}</span>
              </span>
              <span className="block truncate text-xs text-ink-500">
                {t.modeNames[m]} · {t.mood.split('，')[0]}
              </span>
            </span>
            {on && <Check className="size-4 shrink-0 text-brand-600" strokeWidth={2.25} aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

/** 顶栏：太阳 / 月亮图标，点开是深浅色 + 主题的快捷切换（面板由 Menu 限制在视口内，手机上不会被裁掉） */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, meta } = useTheme()
  const Icon = mode === 'dark' ? Moon : Sun
  return (
    <Menu
      className="w-[min(20rem,calc(100vw-1rem))] py-0"
      trigger={(toggle, open) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`外观：${meta.name} · ${meta.modeNames[mode]}`}
          title="外观"
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-full text-ink-700 transition hover:bg-ink-900/[0.07] hover:text-ink-900',
            open && 'bg-ink-900/[0.07] text-ink-900',
            className,
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.5} />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="border-b border-line px-4 pt-3.5 pb-3">
            <p className="eyebrow">Appearance · 外观</p>
            <ModeSwitch size="sm" className="mt-2.5 flex w-full [&>button]:flex-1" />
          </div>
          <div className="p-1.5">
            <ThemeList onPick={close} />
          </div>
        </div>
      )}
    </Menu>
  )
}

/** 账户菜单里的一行：深浅色切换 + 五个主题色块，另有「外观设置」入口 */
export function ThemeMenuSection({ onNavigate }: { onNavigate?: () => void }) {
  const { pref, mode, meta, setTheme, toggleMode } = useTheme()
  return (
    <div className="border-t border-line px-4 pt-3 pb-3.5">
      <div className="flex items-center justify-between gap-3">
        <Link to="/settings#appearance" onClick={onNavigate} className="eyebrow hover:text-ink-900">
          外观 · {meta.name}
        </Link>
        <button
          type="button"
          onClick={toggleMode}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-ink-700 transition-colors hover:border-ink-300 hover:text-ink-900"
          aria-label={mode === 'dark' ? '切换到浅色' : '切换到深色'}
        >
          {mode === 'dark' ? <Moon className="size-3.5" strokeWidth={1.75} /> : <Sun className="size-3.5" strokeWidth={1.75} />}
          {meta.modeNames[mode]}
        </button>
      </div>
      <OptionGroup label="主题" className="mt-3 flex items-center gap-2.5">
        {THEME_IDS.map((id) => {
          const on = pref.theme === id
          const m = on ? mode : modeForTheme(id, pref)
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              title={`${THEMES[id].name} ${THEMES[id].nameEn} · ${THEMES[id].modeNames[m]}`}
              aria-label={`${THEMES[id].name}（${THEMES[id].modeNames[m]}）`}
              onClick={() => setTheme(id)}
              className={cn(
                'rounded-full p-[3px] transition-shadow',
                on ? 'shadow-[0_0_0_2px_var(--color-brand-600)]' : 'hover:shadow-[0_0_0_1px_var(--color-ink-300)]',
              )}
            >
              <ThemeSwatch theme={id} mode={m} size={24} />
            </button>
          )
        })}
      </OptionGroup>
    </div>
  )
}

/** 主题卡片里的缩略页面：用该主题该模式的真实令牌与字体渲染（font-sans 重新取预览主题的界面字体，而不是继承页面的） */
function ThemePreview({ theme, mode, current }: { theme: ThemeId; mode: Mode; current: boolean }) {
  const t = THEMES[theme]
  return (
    <span data-theme={theme} data-mode={mode} className="relative block bg-paper px-3.5 pt-3 pb-3.5 font-sans text-ink-900">
      <span className="flex items-center justify-between gap-2">
        <span className="eyebrow truncate">{t.modeNames[mode]}</span>
        {current && (
          <span className="rounded-full bg-brand-fill px-1.5 py-px text-[10px] leading-4 font-semibold text-on-brand">当前</span>
        )}
      </span>
      <span className="font-display mt-2 block truncate text-[1.375rem] leading-tight">
        Aa 旅途
      </span>
      <span className="mt-1 block h-1.5 w-4/5 rounded-full bg-ink-200" />
      <span className="mt-1 block h-1.5 w-3/5 rounded-full bg-ink-200" />
      <span className="mt-3 flex items-center gap-1.5">
        <span className="th-btn th-btn-primary inline-flex h-6 items-center px-2.5 text-[11px]">保存</span>
        <span className="th-chip is-selected h-6 px-2 text-[11px]">
          <Check strokeWidth={2.75} aria-hidden />
          美食
        </span>
      </span>
      <span className="mt-3 flex gap-1" aria-hidden>
        {['brand-600', 'gold', 'emerald-600', 'sky-600', 'pink-600'].map((c) => (
          <span key={c} className="size-2.5 rounded-full" style={{ background: `var(--color-${c})` }} />
        ))}
      </span>
    </span>
  )
}

/**
 * 一张主题卡片。预览要用该主题的字体：卡片滚进视口（或指针移上、获得焦点）时才引入，
 * 打开设置页不会一次下载五套字体
 */
function ThemeCard({ id }: { id: ThemeId }) {
  const { pref, mode, setTheme } = useTheme()
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      void ensureThemeFonts(id)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        void ensureThemeFonts(id)
        io.disconnect()
      },
      { rootMargin: '0px 0px 120px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [id])
  const t = THEMES[id]
  const on = pref.theme === id
  // 选用后会显示哪个模式：没选过深浅色时是该主题的默认模式（暮色、夜航是深色），否则保持用户的选择
  const m = on ? mode : modeForTheme(id, pref)
  const warm = () => void ensureThemeFonts(id)
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => setTheme(id)}
      onPointerEnter={warm}
      onFocus={warm}
      className={selectedClass(on, 'card', 'flex w-full flex-col overflow-hidden text-left')}
    >
      <span className="grid grid-cols-2 border-b border-line">
        <ThemePreview theme={id} mode="light" current={on && mode === 'light'} />
        <ThemePreview theme={id} mode="dark" current={on && mode === 'dark'} />
      </span>
      <span className="flex items-start gap-3 px-4 pt-3.5 pb-4">
        <span className="min-w-0 flex-1">
          <span className="th-option-title">
            {t.name} <span className="text-[0.8em] text-ink-500">{t.nameEn}</span>
          </span>
          <span className="th-option-desc mt-1.5">{t.mood}</span>
          <span className="mt-2 block text-xs text-ink-500">
            {on ? '正在使用' : '选用后'}：<span className="font-medium text-ink-900">{t.modeNames[m]}</span> · {modeWord(m)}
            {pref.modeChosen && pref.mode === 'system' ? '（跟随系统）' : ''}
            {t.defaultMode !== m ? ` · 为${modeWord(t.defaultMode)}设计` : ''}
          </span>
        </span>
        <CheckBadge />
      </span>
    </button>
  )
}

/** 设置页「外观」：五个主题卡片（每张同时预览浅色与深色），点一下立即生效 */
export function ThemePicker() {
  return (
    <OptionGroup label="主题" className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
      {THEME_IDS.map((id) => (
        <ThemeCard key={id} id={id} />
      ))}
    </OptionGroup>
  )
}
