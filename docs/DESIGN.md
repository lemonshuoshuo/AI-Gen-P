# TripHub 视觉规范 · 多主题

TripHub 有五套主题，每套都有设计过的浅色与深色模式（不是简单反相）。第一次打开是 **手帐 · 浅色（纸页）**，不看系统深浅色；「跟随系统」要在外观里主动选。
所有令牌在 `web/src/index.css`（登记名字与默认值）和 `web/src/styles/themes.css`（每个主题 × 模式的数值），
公共组件在 `web/src/components/ui/index.tsx` 与 `web/src/styles/components.css`，主题运行时在 `web/src/theme/`。
页面只组合令牌和组件，不另起一套颜色、字号或形状。

| id | 名称 | 为谁设计 | 默认模式 | 浅色 / 深色 | 强调色 | 标题字体 |
|---|---|---|---|---|---|---|
| `journal` | 手帐 Journal（**站点默认**） | 所有人 | 浅 | 纸页 / 灯下 | 砖红 | Fraunces + 霞鹜文楷 |
| `camp` | 山野 Camp | 周末、户外、年轻人 | 浅 | 日野 / 营火 | 松林绿 + 万寿菊黄 | Bricolage Grotesque + 系统黑体 |
| `coast` | 晴海 Coast | 海岛、夏天、博主 | 浅 | 晴日 / 夜潮 | 爱琴海蓝 + 珊瑚 | Instrument Serif + 系统黑体 |
| `dusk` | 暮色 Dusk | 情侣、纪念 | 深 | 晨粉 / 暮色 | 腮红粉 | Newsreader + 思源宋体 |
| `voyage` | 夜航 Voyage（原主题） | 喜欢电影感的人 | 深 | 白昼 / 夜航 | 朱砂 + 象牙白 | Cormorant + 思源宋体 |

## 1. 原则

1. **主次清楚**：每屏只有一个展示级标题；正文 15px、辅助 13px、标签 11–12px。字号上限见第 3 节，页面不写超过上限的任意字号。
2. **选中一眼可见**：选中项同时有强调色描边、浅色底纹、实心勾选徽章、强调色标题（至少三条）；未选中项保持正常的 ink-900 标题，**绝不靠「未选中变灰」表达选中**（第 4 节）。
3. **只用令牌**：颜色、圆角、阴影、字体都来自令牌，页面里不写十六进制颜色（照片上的 `text-white`、`bg-black/xx` 遮罩除外）。这样同一页面在十种外观下都成立。
4. **照片与路线是主角**：界面安静，强调色只用在主操作、当前 / 选中状态、路线。
5. **中文排版**：标题开 `'halt'`（半角标点）；中文不做斜体、不伪造粗体（全局 `font-synthesis: none`）；西文强调词可以用斜体。

## 2. 运行机制

- `<html data-theme="journal|camp|coast|dusk|voyage" data-mode="light|dark">`。偏好 `{ theme, mode: 'system' | 'light' | 'dark', modeChosen }` 存在 localStorage `triphub.theme`，默认 `{ journal, light, modeChosen: false }`，只保存在本设备。
- **深浅色跟着主题，直到用户自己选**：`modeChosen = false` 时，换主题就换成该主题设计时的模式（`THEMES[id].defaultMode`：暮色、夜航是深色，其余浅色），所以选「夜航」看到的就是夜航；用户在任何入口选过「跟随系统 / 浅色 / 深色」后（`setMode` / `toggleMode`），换主题都保持这个选择。设置页可以「改回跟着主题」（`setThemePref({ modeChosen: false })`）。主题卡片和快捷菜单用 `modeForTheme(id)` 预告「选用后」是哪个模式。
- `web/index.html` 里的内联脚本在首次绘制前按同样的规则写好属性、`color-scheme`、`<meta name="theme-color">`（= 该主题该模式的 paper），不会先闪一下默认主题（逻辑与 `runtime.ts` 的 `readPref` 一致，改一处要同步另一处）。
- `web/src/theme/runtime.ts`：`useTheme()`（zustand）读写偏好；`setTheme` / `setMode` / `toggleMode` / `setThemePref`；「跟随系统」实时响应 `prefers-color-scheme`；多个标签页同步；每次变化在 `window` 上派发 **`triphub:theme`** 事件（`onThemeChange(cb)` 订阅），供地图等非 React 代码使用；`getResolvedTheme()` 读当前生效的主题。
- **按文字宽度排版的组件**（撑满整行的字标、按宽度缩放的封面标题）：字体是懒加载的，第一次测量时主题字体往往还没到，换主题后字宽也会变。把 `useTypeEpoch()`（字体下载完成、换主题 / 深浅色时变化）放进测量的 `useLayoutEffect` 依赖里，并用 `ResizeObserver` 同时观察容器和文字本身。
- **横向溢出保险**：`#root` 设了 `overflow-x: clip`，任何元素都撑不出整页横向滚动（手机上不会把布局视口和固定底栏撑宽）。它只是保险——超宽的元素仍会被裁掉，要在组件里修。
- 切换入口：顶栏太阳 / 月亮按钮（深浅色 + 主题快捷切换）、账户菜单「外观」一行、设置页「外观」（主题卡片同时预览浅色与深色）。组件在 `web/src/theme/ThemeControls.tsx`。
- **局部主题**：主题块的选择器只用属性，任何元素加上 `data-theme` + `data-mode` 就得到一整套令牌。3D 夜景等在浅色模式下也要深色界面的区域用 `<div {...useThemeScope('dark')}>`；设置页的主题预览也是这样渲染的。
- 字体按主题懒加载：`web/src/theme/fonts/<id>.css`，由运行时在切换到该主题时引入；中文网络字体（霞鹜文楷、思源宋体）按 unicode-range 切片、`font-display: swap`，只下载页面用到的字，不阻塞渲染。山野、晴海不加载中文网络字体（用系统黑体）。设置页的主题卡片要用各主题的字体预览，但只在卡片进入视口（或指针移上、获得焦点）时才引入那个主题的字体，打开设置页不会一次下载五套。

## 3. 令牌

### 3.1 颜色（语义在所有主题中一致）

| 令牌 | 用途 |
|---|---|
| `paper`（= `ink-50`） | 页面底色 |
| `surface`、`surface-2` | 卡片、输入框、菜单、弹窗 |
| `line`（= `ink-200`） | 细线、边框 |
| `ink-900` / `-700` / `-500` / `-400` | 主文字 / 正文段落 / 元信息 / 注释（ink-400 在 paper 上 ≥ 5:1）；`ink-300` 只做装饰和禁用 |
| `brand-50…900` | 强调色阶：`brand-50` 选中底纹，`brand-600` 强调文字、描边、下划线（≥ 6.4:1），`brand-700` 选中标题 |
| `brand-fill` + `on-brand` | 实心主按钮、选中徽章、选中 chip 的底色与字色 |
| `gold` + `on-gold` | 山野的主按钮与选中徽章；其他主题是少量点缀 |
| `emerald / amber / red / sky / violet / pink` | 推荐 / 一般 / 踩雷 / 计划 / GPS / 我们。`50/100` 做底纹，`600/700` 做文字（600 ≥ 5:1，700 ≥ 6.4:1） |
| `night` | 3D 夜景底色（两种模式下都是深色） |
| `sunset-400`、`orange-500/600`、`indigo-500`、`violet-brand` | 少量图表与分类色 |

**色阶方向随模式翻转**：深色模式下 `ink-50` 仍是页面底色、`ink-900` 仍是主文字，`brand-50` 仍是（深色的）底纹、`brand-600` 仍是可读的强调色。所以 `text-ink-900 bg-brand-50` 这样的类名在两种模式下都成立，页面不需要写 `dark:`。

### 3.2 字体

| 工具类 | 变量 | 用途 |
|---|---|---|
| `font-display` | `--font-display` | 标题、卡片标题（字重、可变轴由主题决定：`--display-weight`、`--display-variation`） |
| `font-sans` | `--font-sans` | 界面与正文（body 默认） |
| `font-num` | `--font-num` | 天数、里程、序号（等高、等宽数字） |
| `font-label` | `--font-label` | 标签（`eyebrow` 已使用；山野是 DM Mono） |
| `font-prose` | `--font-prose` | 游记正文（`prose-trip` 已使用；手帐是霞鹜文楷） |

页面上为夜航写的 `font-normal` / `font-light` 放在展示字（h1–h3、`font-display`、`text-display-*`）上时，会改用主题的展示字重（山野是 650 的粗 grotesk）；`font-num font-normal` 用主题数字字重 `--num-weight`，`font-num font-light`（旧页面的大数字）用轻一档的 `--num-light-weight`（手帐 / 暮色 / 夜航 300、山野 / 晴海 400），不会变成粗块。新写的大数字用 `font-num text-num`，不要靠 `font-light` 压重量。

中文回退字体：手帐的标题与游记在霞鹜文楷到达前先用系统楷体（`Kaiti SC` / `STKaiti` / Windows 的 `KaiTi`、`楷体`），暮色、夜航的标题先用系统宋体（含 Windows 的 `SimSun`），避免加载时「宋体 → 楷体」这类明显的跳变。

### 3.3 字号档（桌面 → 手机由 `clamp()` 自动过渡）

| 角色 | 工具类 | 手帐 | 山野 | 晴海 | 暮色 | 夜航 |
|---|---|---|---|---|---|---|
| 首页 hero | `text-display-xl`（`text-hero`） | 56 / 34 | 56 / 36 | 60 / 38 | 54 / 34 | 60 / 36 |
| 页面 H1 | `text-display-lg`（`text-h1`） | 38 / 28 | 36 / 28 | 42 / 30 | 36 / 28 | 40 / 28 |
| 区块 H2 | `text-display-md`（`text-h2`） | 26 / 21 | 24 / 20 | 30 / 24 | 26 / 22 | 28 / 22 |
| 卡片标题 | `text-card` | 18 / 17 | 18 / 16 | 21 / 19 | 19 / 17 | 20 / 18 |
| 正文 | `text-body` | 15 | 15 | 15 | 15 | 15 |
| 辅助 | `text-small`、`caption` | 13 | 13 | 13 | 13 | 13 |
| 标签 | `text-label`、`eyebrow` | 11.5 / 11 | 12 / 11 | 11.5 / 11 | 11 | 11 |
| 大数字 | `text-num` | 40 / 30 | 44 / 32 | 48 / 36 | 42 / 32 | 44 / 32 |

- 页面 H1 用 `text-display-lg`，不要用 `text-display-xl`；`text-display-xl` 只给首页 hero 和旅程封面。
- 不要再用 `max-sm:text-[3.25rem]`、`lg:text-[clamp(…)]` 之类覆盖展示字号，也不要写 `text-[5rem]` 以上的数字——大数字用 `font-num text-num`。
- `eyebrow`：小标签（如 `Itinerary · 行程`），字体、字距、是否大写由主题决定，颜色 ink-500。`caption`：13px 元信息。

### 3.4 形状、阴影、质感

- 通用圆角 `rounded-sm…3xl` 的数值随主题变化（夜航几乎直角、山野很圆）。组件档：`rounded-btn`、`rounded-field`、`rounded-card`、`rounded-option`、`rounded-modal`、`rounded-image`（照片用它）。
- 阴影 `shadow-card`、`shadow-float`：浅色模式是柔和的真实阴影，深色模式是一圈细亮线 + 深投影。
- `glass`：半透明的纸（顶栏、底部导航、地图控件）；`glass-dark`：照片 / 夜景上的深色玻璃；`bg-night`：3D 夜景；`bg-love-gradient`：「我们」的淡底纹；`select-chevron`、滚动条、选区、焦点环都随主题。
- 纸纹 / 胶片颗粒：手帐（浅 / 深都有）、暮色深色、夜航；山野、晴海没有。
- 图标描边自动随主题：`components.css` 把 lucide 图标上常用的描边（1.25 / 1.4 / 1.5 / 1.75 / 默认 2）以 1.5 为基准按 `--icon-stroke` 等比换算（山野更粗、暮色更细）；小于 1.25 的装饰细线和大于 2 的加粗勾选保持原样。页面不用再给每个图标写「默认」的 `strokeWidth`。

## 4. 选中态（所有主题统一的规则）

选中至少同时满足以下三条：

1. 强调色描边（1.5–2px `brand-600`；未选中是 1px `line`，手帐为虚线）；
2. 浅色底纹 `brand-50`（深色模式下是深色底纹）；
3. 实心勾选徽章：`brand-fill` 底 + `on-brand` 勾（山野是金色底；未选中是 `ink-300` 空心圆 / 方框）；
4. 标题变为 `brand-700` 或加粗一级，序号变为 `brand-600`。

**未选中的标题保持 `ink-900`。** Tab：选中 `ink-900` + 600 字重 + 2px 下划线（山野、暮色是胶囊）。Chip：选中实心 + 勾。列表行：选中 `brand-50` 底 + 左侧亮条（山野、暮色是圆点）+ 标题 600。**文字筛选**（「全部 / 游记 / 路线攻略」「热门 / 高分 / 避雷榜」）也用 Tab 的语言：`selectedClass(active, 'filter')`，下划线主题是 2px 强调色下划线 + 600，山野 / 暮色是实心胶囊（元素给 `px-3` 左右的内边距），未选中 ink-500——不再用「ink-900 对 ink-400 + 1px 下划线」。

悬停只作用于未选中的选项（选中项在指针下保持强调色描边与底纹）：手帐、暮色、夜航描边变 `ink-300` 实线，山野上浮 2px + `shadow-float`，晴海阴影加深（`--option-hover-border / -shadow / -lift`）。列表行的悬停底色也只加在未选中的行上。

组件（`@/components/ui`）：

```tsx
// 大选项（单选）：外层 OptionGroup 提供 role=radiogroup 与方向键
<OptionGroup label="创建方式" className="grid gap-3 sm:grid-cols-3">
  {modes.map((m, i) => (
    <OptionCard key={m.value} selected={mode === m.value} onClick={() => setMode(m.value)}
      index={i + 1} eyebrow={m.en} title={m.title} description={m.desc} />
  ))}
</OptionGroup>

// 筛选 chip（多选；单选时 role="radio"）
<ChoiceChip selected={on} onClick={toggle} icon={<Utensils />}>美食</ChoiceChip>

// 自己排版的元素套用同一套选中样式：'card' | 'row' | 'chip' | 'tab'
<button role="radio" aria-checked={on} className={selectedClass(on, 'card', 'p-4')}>
  <span className="th-option-title">…</span><CheckBadge />
</button>
<li aria-current={on ? 'true' : undefined} className={selectedClass(on, 'row', 'px-3 py-2')}>
  <span className="th-sel-title">龙井村</span>
</li>
// 文字筛选 / 文字 Tab
<button aria-pressed={active} className={selectedClass(active, 'filter', 'h-8 px-3 text-[13.5px]')}>热门</button>
```

样式同时认 `aria-checked` / `aria-selected` / `aria-pressed` / `aria-current` 和 `.is-selected`，请务必写上 aria 属性（单选组 `role="radio"` + `aria-checked`）。`TabBar`（role=tablist）、`Segmented`（role=radiogroup，方向键可切换）已经使用同一套规则。

## 5. 组件

- 按钮 `Button` / `buttonClass()`：`primary` 是主题的实心主按钮（手帐砖红、山野万寿菊黄、晴海海蓝、暮色腮红、夜航象牙白 / 近黑）；`accent` 每页最重要的一个动作（山野松绿、晴海珊瑚、暮色深玫瑰、夜航朱砂）；`outline` 细线（山野、暮色是 `ink-900` 描边，其他主题 `ink-300`，令牌 `--btn-outline-border`）；`ghost` 纯文字；`danger` 红；`love` 仅情侣空间；`dark` 反色。形状（胶囊 / 圆角矩形）由主题决定，API 不变。
- 输入框 `Input` / `Textarea` / `Select`：主题的底色、描边、圆角；聚焦时 `brand-600` 描边 + 3px 光圈。`Field` 标签 12.5px。
- `Card`：手帐虚线纸片、山野 / 晴海带柔和阴影的实心卡、暮色细线实心卡、夜航只有细线。
- `Modal`、`Menu`、提示条：`surface` 浮层 + 主题的圆角与阴影，遮罩随模式。`Menu` 的面板贴着触发按钮，但会水平挪回视口内（四周留 8px，手机顶栏右侧的菜单不会被裁掉）；在菜单外任何地方按下都会关闭（包括毛玻璃顶栏里的菜单——那里的全屏遮罩只能盖住顶栏）。
- `VerdictBadge`：`emerald/amber/red-100` 底 + `-700` 字；`CategoryChip`、`LevelBadge`、默认头像的颜色都来自矿物色阶，随主题变化。
- 图标：lucide，16–20px；描边手帐 / 晴海 1.5、山野 1.75、暮色 1.25、夜航 1.4（`--icon-stroke`，按第 3.4 节自动换算）。

## 6. 主题说明

- **手帐 Journal**：米白纸、砖红墨水、虚线打孔线。卡片与选项是虚线纸片，选中变实线 + 略微歪着的方形「邮戳」勾。按钮 6px 圆角。标题 Fraunces + 霞鹜文楷，游记正文霞鹜文楷。深色「灯下」是可可色的暖墨底，不是反相。
- **山野 Camp**：奶油、松林绿、万寿菊黄。大圆角实心卡 + 柔和阴影，胶囊按钮，主按钮与选中徽章是金色；Tab 是胶囊分段；标签用 DM Mono。标题 Bricolage Grotesque 650 + 系统黑体（粗）。焦点环 3px：深色「营火」是金色；浅色「日野」改用松绿 `brand-600`（金色在奶油底上只有约 1.7:1，键盘焦点看不清）。
- **晴海 Coast**：盐白、爱琴海蓝，珊瑚只在「太阳」时刻（accent、GPS 轨迹、当前位置）。白色卡片 + 柔和阴影，照片大圆角（`rounded-image` 24px）。标题 Instrument Serif（只有 400，不加粗）+ 系统黑体常规字重。地图保留最多色彩。
- **暮色 Dusk**：可可棕 + 腮红粉，默认深色。胶囊按钮与胶囊 Tab 都是腮红实心；按钮字距加宽。标题 Newsreader + 思源宋体，西文强调词可用斜体。动效慢而柔。
- **夜航 Voyage**：原主题，近黑 + 象牙白 + 朱砂，默认深色；新增浅色「白昼」。选项是细线条目，选中为 `ink-100` 底 + 左侧 2px 亮条 + 实心勾 + 朱砂序号；Tab 下划线 2px。标题 Cormorant + 思源宋体，数字保留细字。

## 7. 地图与 3D

- 底图：`web/src/components/map/style.ts` 为每个主题 × 模式给出栅格调色、底色、天空、兜底省界配色。`normal` = 当前模式的底图；`dark` = 该主题的夜色（3D 夜景，任何模式下都深）；`auto` = 全国级夜色、放大到城市级过渡到当前模式的底图；`satellite` 不变。
- 主题切换：用过 `setBaseKind` 的地图会在 `triphub:theme` 时自动重新套色（`rasterTone` 等页面覆盖的调色保留）；也可以手动 `applyThemeToMap(map)`。
- 路线与标记：MapLibre 线图层用 `routeColors(kind)`（实际 / 计划 / GPS）并在 `triphub:theme` 时重设；HTML 标记直接用 CSS 变量 `--route-actual`、`--route-planned`、`--route-track`、`--marker-bg`、`--marker-fg`、`--marker-ring`、`--marker-planned-bg`、`--marker-planned-fg`、`--marker-planned-ring`、`--marker-current`、`--marker-font`、`--map-bg`（切换主题时自动更新，不用重新渲染）。
- 标记的目标形态（`components/map/layers.tsx` 按此改用上面的变量）：手帐圆形「邮戳」（砖红底 + 纸色圈）、山野金色旗形胶囊、晴海白色浮标（海蓝圈）、暮色腮红圆点、夜航反色印章；计划中的点都是纸色底 + 虚线 `sky-600` 圈。
- 地图外框：无底色，最多一圈 `ring-1 ring-line`，圆角 `rounded-image`；控件用 `glass` + 细线胶囊。

## 8. 分享海报

`components/trip/SharePoster.tsx` 在画布上按当前主题与模式取色（paper、ink-900、ink-500、line、brand-600 / 情侣空间 pink-600）和字体（标题、数字、界面），浅色主题得到米白海报、深色主题得到深色海报；二维码永远是浅底深码。

## 9. 添加 / 调整主题

1. `web/src/styles/themes.css`：复制一个主题的三个块——`[data-theme='x'][data-mode='light']`、`[data-theme='x'][data-mode='dark']`（完整颜色色阶、`--th-shadow-card/float`、路线色、`--grain-opacity`，需要时按模式覆盖 `--focus-color`）和 `[data-theme='x']`（字体、字号 clamp、`--num-weight` / `--num-light-weight`、圆角、按钮含 `--btn-outline-border`、组件形状、选项悬停 `--option-hover-*`、焦点、图标描边、标记）。深色模式按「ink-50 = 底色、ink-900 = 主文字」翻转色阶，不要反相。
2. 对比度目标：`ink-900` ≥ 14，`ink-500` ≥ 6，`ink-400` ≥ 5（深色 ≥ 5.2，在 surface 上 ≥ 4.7），`brand-600` ≥ 6.4，所有矿物色 600 ≥ 5、700 ≥ 6.4，`on-brand` / `brand-fill` ≥ 4.5（均在 paper 上）。
3. `web/src/theme/themes.ts`：登记名称、文案、默认模式、模式名、`themeColor`（= 两个模式的 paper）；同步 `web/index.html` 内联脚本里的 paper 表（`[浅色 paper, 深色 paper, 默认模式]`）。
4. 字体：`web/src/theme/fonts/<id>.css`（只 `@import` 需要的 @fontsource 文件；中文字体必须是 unicode-range 切片），并在 `runtime.ts` 的 `fontLoaders` 登记；海报数字字体在 `SharePoster.tsx` 的 `NUM_FONTS` 登记。
5. 地图：`style.ts` 的 `PALETTES` 加两个模式的调色、底色、天空、省界与路线色。
6. 用 Playwright 截图检查首页、旅程详情、打卡地、设置页（1440×900 与 390×844，两种模式），特别是选中态和小字对比度。

## 10. 不要做

- 不写十六进制颜色、不写 `bg-white` 卡片（照片遮罩除外）、不用 `dark:` 变体（令牌已经处理模式）。
- 不写超过字号上限的任意字号；不在同一屏放两个展示级标题。
- 不把未选中项变灰来表示选中；不省略 `aria-checked` / `aria-selected`。
- 不给中文加斜体或粗体伪造；Instrument Serif、霞鹜文楷、思源宋体只有 400。
