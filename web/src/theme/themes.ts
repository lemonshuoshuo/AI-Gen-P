/**
 * 主题登记表：名称、文案、默认模式。颜色、字体、形状都在 styles/themes.css（按 data-theme / data-mode 生效），
 * 这里只放 JS 需要的少量数据：<meta name="theme-color">（= 页面底色，需与 index.html 里的首屏脚本一致）。
 */
export type ThemeId = 'journal' | 'camp' | 'coast' | 'dusk' | 'voyage'
export type Mode = 'light' | 'dark'
export type ModePref = Mode | 'system'

export interface ThemeMeta {
  id: ThemeId
  /** 中文名：手帐 */
  name: string
  /** 西文名：Journal */
  nameEn: string
  /** 主题选择器文案 */
  mood: string
  moodEn: string
  /** 这个主题「设计时」的模式（暮色、夜航是深色）；用户可以随时切换 */
  defaultMode: Mode
  /** 每个模式的名字：纸页 / 灯下 … */
  modeNames: Record<Mode, string>
  /** 页面底色（paper），用于 <meta name="theme-color"> */
  themeColor: Record<Mode, string>
}

export const DEFAULT_THEME: ThemeId = 'journal'

export const THEMES: Record<ThemeId, ThemeMeta> = {
  journal: {
    id: 'journal',
    name: '手帐',
    nameEn: 'Journal',
    mood: '米白纸页、砖红墨水与虚线邮戳，像一本慢慢写满的旅行手帐。',
    moodEn: 'Cream paper, rust ink and perforated lines — a travel journal you fill in slowly.',
    defaultMode: 'light',
    modeNames: { light: '纸页', dark: '灯下' },
    themeColor: { light: '#fbf6ea', dark: '#1b1714' },
  },
  camp: {
    id: 'camp',
    name: '山野',
    nameEn: 'Camp',
    mood: '奶油底、松林绿与万寿菊黄，圆润大方，适合说走就走的周末和户外。',
    moodEn: 'Cream, pine green and marigold — rounded, friendly, made for weekends outdoors.',
    defaultMode: 'light',
    modeNames: { light: '日野', dark: '营火' },
    themeColor: { light: '#fbf8ec', dark: '#121712' },
  },
  coast: {
    id: 'coast',
    name: '晴海',
    nameEn: 'Coast',
    mood: '盐白底、爱琴海蓝配珊瑚橘，明亮通透，像地中海边的夏天。',
    moodEn: 'Salt white, Aegean blue and coral — bright, airy, a Mediterranean summer.',
    defaultMode: 'light',
    modeNames: { light: '晴日', dark: '夜潮' },
    themeColor: { light: '#f9f8f4', dark: '#0e1621' },
  },
  dusk: {
    id: 'dusk',
    name: '暮色',
    nameEn: 'Dusk',
    mood: '可可棕的黄昏配一抹蔷薇粉，柔软的衬线斜体，适合情侣和珍藏的回忆。',
    moodEn: 'Cocoa dusk with a blush of rose and soft italic serifs — for couples and keepsakes.',
    defaultMode: 'dark',
    modeNames: { light: '晨粉', dark: '暮色' },
    themeColor: { light: '#f6eee8', dark: '#1d1411' },
  },
  voyage: {
    id: 'voyage',
    name: '夜航',
    nameEn: 'Voyage',
    mood: '近黑底、象牙白与朱砂，电影感的整幅照片——保留的原有主题，字号收敛。',
    moodEn: 'Near-black, ivory and cinnabar with cinematic photos — the original theme, calmer type.',
    defaultMode: 'dark',
    modeNames: { light: '白昼', dark: '夜航' },
    themeColor: { light: '#f3f1ec', dark: '#0b0b0a' },
  },
}

export const THEME_IDS = Object.keys(THEMES) as ThemeId[]

export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && v in THEMES
export const isModePref = (v: unknown): v is ModePref => v === 'light' || v === 'dark' || v === 'system'
