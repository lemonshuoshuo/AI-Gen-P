# TripHub 视觉规范 ·「夜航」

参考气质：exemplarfromsweden.com 一类的高端品牌站——近黑底色、超大号高反差衬线字、极小的无衬线标签、整幅的电影感照片、极细的分隔线、大量留白，几乎不用颜色。
所有设计令牌在 `web/src/index.css`，公共组件在 `web/src/components/ui/index.tsx`，页面只组合，不另起一套。

## 1. 色彩（深色唯一主题）

墨色与各色阶已整体反转：`50` 是最深的底色，`900` 是最亮的文字。原来的类名照常用即可。

| 角色 | 类名 | 说明 |
|---|---|---|
| 页面底色 | `bg-paper`（= `bg-ink-50` `#0b0b0a`） | 近黑暖色，自带极淡胶片颗粒 |
| 输入框 / 菜单 / 弹窗 | `bg-surface` `#121211`、`bg-surface-2` `#181816` | 只给「可交互的浮层和输入」用。**内容不要装进有底色的卡片**，用留白和细线组织 |
| 正文 / 标题 | `text-ink-900` 象牙白；正文段落 `text-ink-700`；元信息 `text-ink-500`；注释 `text-ink-400` | 不用纯白（照片上的文字除外，用 `text-white`） |
| 细线 | `border-ink-200`（`#2a2926`）、`divide-ink-200` | 分隔一切 |
| 朱砂 | `brand-*`（500 `#cf6041`） | 只用于：进行中 / 当前状态的小圆点、踩雷、每页最多一个 `accent` 按钮 |
| 矿物色 | `emerald`=推荐、`amber`=一般、`red`=踩雷、`sky`=计划路线… | 只以**小圆点、细线、文字**出现；`bg-*-50/100` 是深色底纹，可做极小面积的标签底 |
| 照片 | 真实照片是主角 | 没有照片时用「近黑 + 超大宋体地名 + 细线邮戳」，不用彩色色块 |

禁止：亮色大色块、渐变装饰、彩色卡片背景、阴影堆叠、白色底的卡片 / 标签（`bg-white/xx` 只允许作为照片上的极淡遮罩）。

## 2. 字体

- 展示标题：`font-display` = Cormorant Garamond（西文）+ 思源宋体 400（中文）。只加载了 400 的中文字重，**不要用 font-bold / font-semibold 做标题**。
  - 超大：`text-display-xl`（首页主标题、旅程封面标题，最大约 120px）
  - 大：`text-display-lg`（页面 H1，约 36–76px）
  - 中：`text-display-md`（区块标题，约 28–46px）
  - 卡片标题：`font-display text-xl`～`text-2xl`
- 数字：`font-num`（Cormorant 等高数字），**用细字重、大字号**：`font-light text-5xl`～`text-7xl`，单位与标签是 11–12px 的无衬线灰字。
- 标签：`eyebrow`（Manrope 11px，大写，字距 0.16em，灰）。写法：`<p className="eyebrow">Itinerary · 行程</p>`。
- 说明文字对（照片说明、元信息）：第一行 `text-[13px] text-ink-900`，第二行 `caption`（13px 灰）。
- 正文：Manrope + 系统中文黑体，14–15px，行高 1.8；长文 `prose-trip`。
- 字号对比要大：标题与正文的字号差距越大越显高级。一屏里只有一个视觉焦点。

## 3. 版式

- 宽度：外层 `mx-auto max-w-[90rem] px-4 md:px-8`（与顶栏对齐）；阅读正文 `max-w-2xl`。
- 纵向节奏：桌面区块之间 `py-20`～`py-32`，移动 `py-12`～`py-16`。留白是高级感的来源，宁多勿少。
- 区块头（Exemplar 的样式）：一条 `border-t border-ink-200`，下面一行小字——左侧 `eyebrow` 标签 + 灰色计数 / 说明，右侧「全部 →」；再往下才是超大标题或内容。
- 网格：不对称网格（如 5/7、4/8 分栏），图片与文字错落；列表用「细线 + 排版」而不是卡片。
- 圆角：图片 `rounded-none` 或 `rounded-sm`；按钮是胶囊（组件已设置）；输入框 `rounded-md`；弹窗 `rounded-xl`。
- 移动端：左右 16px，展示字号自动缩放；不要横向滚动。

## 4. 图片

- 整幅出血（full-bleed）或占满栅格列，比例 4:5、3:2、16:9；`object-cover`。
- 照片上的文字：底部 `bg-gradient-to-t from-black/70 via-black/20 to-transparent` 的极淡遮罩 + `text-white`。
- 悬停：只让图片在 700ms 内缓慢放大到 1.03（`transition-transform duration-700 ease-out group-hover:scale-[1.03]`），文字不动。
- 说明文字放在图片下方，两行式（亮 + 灰）。

## 5. 组件

- 按钮：`primary` 象牙白实心胶囊；`outline` 细线胶囊；`ghost` 纯文字；`accent` 朱砂（每页最多一个）；`love` 仅情侣空间。
- 链接式操作：`text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900` 或「文字 + →」。
- 标签：`Tag`（细线胶囊）、`VerdictBadge`（◎推荐 / ○一般 / ✕踩雷）、`CategoryChip`（小图标 + 文字）。
- 统计：大号细字 Cormorant 数字 + 小标签，多个统计之间用竖细线分隔。
- 图标：lucide，`strokeWidth={1.25}`～`1.5`，16–20px。不用 emoji。

## 6. 地图与 3D

- 标准底图是暖石墨色（`components/map/style.ts`），夜间底图偏黛青，卫星照旧。
- 路线：实际路线朱砂实线（夜间金色），计划路线黛青虚线，GPS 轨迹赭黄；标记为反转的印章（已到达象牙白实心，计划中黑底虚线）。
- 地图外框：无底色，最多一圈 `ring-1 ring-ink-200`，圆角 `rounded-sm`；地图上的控件用 `glass` + 细线胶囊。

## 7. 动效

- 进入：`animate-fade-in`、`animate-slide-up`（0.5–0.7s，expo 缓出），可按元素错开 60–80ms。
- 悬停：颜色、细线、图片缓慢放大；不做弹跳。
