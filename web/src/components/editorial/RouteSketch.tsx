// 线描路线插图：江南五日线（上海 → 乌镇 → 杭州 → 千岛湖 → 黄山）
// 实际走过的路段用朱砂实线，计划路段用墨色虚线；等高线、海岸线、经纬网都是极淡的细线。纯装饰，读屏忽略
import { cn } from '@/lib/cn'

type Stop = { x: number; y: number; name: string; day: string; lx: number; ly: number; anchor: 'start' | 'middle' | 'end'; state: 'done' | 'now' | 'plan' }

const stops: Stop[] = [
  { x: 387, y: 74, name: '上海', day: 'Day 1', lx: 374, ly: 62, anchor: 'end', state: 'done' },
  { x: 289, y: 136, name: '乌镇', day: 'Day 2', lx: 276, ly: 124, anchor: 'end', state: 'done' },
  { x: 255, y: 196, name: '杭州', day: 'Day 3 · 此刻', lx: 270, ly: 222, anchor: 'start', state: 'now' },
  { x: 143, y: 281, name: '千岛湖', day: 'Day 4', lx: 196, ly: 300, anchor: 'start', state: 'plan' },
  { x: 57, y: 214, name: '黄山', day: 'Day 5', lx: 57, ly: 160, anchor: 'middle', state: 'plan' },
]

export function RouteSketch({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 380" className={cn('h-auto w-full text-ink-900', className)} aria-hidden fill="none">
      {/* 经纬网 */}
      <g stroke="currentColor" strokeOpacity={0.09} strokeWidth={0.75} strokeDasharray="2 4">
        {[140, 240, 340, 440].map((x) => (
          <line key={x} x1={x} x2={x} y1={8} y2={372} />
        ))}
        {[104, 230, 356].map((y) => (
          <line key={y} x1={8} x2={472} y1={y} y2={y} />
        ))}
      </g>
      <g fill="currentColor" fillOpacity={0.38} fontFamily="var(--font-num)" fontSize={9} fontStyle="italic">
        {['119°E', '120°E', '121°E', '122°E'].map((t, i) => (
          <text key={t} x={144 + i * 100} y={18}>
            {t}
          </text>
        ))}
        <text x={12} y={100}>31°N</text>
        <text x={12} y={226}>30°N</text>
      </g>

      {/* 海岸线与杭州湾 */}
      <path
        d="M438 8 C 430 34, 424 56, 412 80 C 402 100, 380 120, 352 142 C 332 158, 318 172, 314 182 C 330 190, 360 196, 392 204 C 420 212, 446 226, 440 256 C 436 282, 452 310, 448 340 C 446 356, 452 366, 456 376"
        stroke="currentColor"
        strokeOpacity={0.32}
        strokeWidth={0.9}
      />
      <g stroke="currentColor" strokeOpacity={0.12} strokeWidth={0.75} strokeLinecap="round">
        {[
          [440, 110, 462],
          [428, 128, 452],
          [446, 146, 470],
          [458, 168, 474],
          [462, 262, 476],
          [468, 288, 478],
        ].map(([x1, y, x2]) => (
          <line key={`${x1}-${y}`} x1={x1} x2={x2} y1={y} y2={y} />
        ))}
      </g>
      <text x={462} y={300} fill="currentColor" fillOpacity={0.3} fontFamily="var(--font-display)" fontSize={13} letterSpacing={2} style={{ writingMode: 'vertical-rl' }}>
        东海
      </text>

      {/* 黄山等高线 */}
      <g stroke="currentColor" strokeOpacity={0.16} strokeWidth={0.75}>
        <path d="M14 222 C 12 190, 46 174, 78 184 C 106 193, 110 226, 92 244 C 72 262, 32 262, 20 246 C 16 240, 14 232, 14 222 Z" />
        <path d="M28 220 C 28 198, 52 188, 74 196 C 94 203, 96 226, 82 238 C 66 250, 38 248, 31 236 C 29 232, 28 226, 28 220 Z" />
        <path d="M42 218 C 43 206, 56 200, 68 205 C 80 210, 80 226, 70 231 C 60 237, 44 232, 42 224 Z" />
      </g>
      {/* 千岛湖 */}
      <path
        d="M112 292 C 116 274, 136 268, 152 274 C 170 280, 190 286, 184 300 C 178 312, 162 304, 150 312 C 136 320, 108 310, 112 292 Z"
        fill="currentColor"
        fillOpacity={0.035}
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={0.75}
      />

      {/* 计划路段：墨色虚线 */}
      <path
        d="M255 196 C 232 238, 186 262, 143 281 C 112 292, 70 262, 57 214"
        stroke="currentColor"
        strokeOpacity={0.55}
        strokeWidth={1.25}
        strokeDasharray="4 5"
        strokeLinecap="round"
      />
      {/* 实际路段：朱砂实线 */}
      <path
        d="M387 74 C 352 88, 318 104, 289 136 C 270 158, 262 178, 255 196"
        className="stroke-brand-500"
        strokeWidth={1.9}
        strokeLinecap="round"
      />

      {/* 站点 */}
      {stops.map((s) => (
        <g key={s.name}>
          {s.state === 'now' && <circle cx={s.x} cy={s.y} r={9} className="stroke-brand-500" strokeWidth={1} />}
          <circle
            cx={s.x}
            cy={s.y}
            r={s.state === 'now' ? 4 : 4.5}
            className={s.state === 'now' ? 'fill-brand-500' : s.state === 'done' ? 'fill-ink-900' : 'fill-paper stroke-ink-900'}
            strokeWidth={1.2}
          />
          <text x={s.lx} y={s.ly} textAnchor={s.anchor} fill="currentColor" fontFamily="var(--font-display)" fontSize={15} fontWeight={600}>
            {s.name}
          </text>
          <text
            x={s.lx}
            y={s.ly + 14}
            textAnchor={s.anchor}
            className={s.state === 'now' ? 'fill-brand-600' : 'fill-ink-400'}
            fontFamily="var(--font-num)"
            fontSize={10}
            fontStyle="italic"
          >
            {s.day}
          </text>
        </g>
      ))}

      {/* 指北针 */}
      <g transform="translate(64 72)" stroke="currentColor" strokeWidth={0.9}>
        <circle r={17} strokeOpacity={0.35} />
        <path d="M0 -13 L4 0 L0 13 L-4 0 Z" strokeOpacity={0.7} />
        <path d="M0 -13 L4 0 L-4 0 Z" fill="currentColor" stroke="none" />
        <text y={-23} textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-num)" fontSize={10} fontWeight={600}>
          N
        </text>
      </g>

      {/* 比例尺 */}
      <g transform="translate(24 350)" stroke="currentColor" strokeWidth={0.9}>
        <line x1={0} x2={80} y1={0} y2={0} />
        {[0, 40, 80].map((x) => (
          <line key={x} x1={x} x2={x} y1={-4} y2={x === 40 ? -2 : 0} />
        ))}
        <rect x={0} y={-2} width={40} height={2} fill="currentColor" stroke="none" />
        <text x={90} y={3.5} fill="currentColor" stroke="none" fontFamily="var(--font-num)" fontSize={10} fontStyle="italic">
          50 km
        </text>
      </g>
    </svg>
  )
}
