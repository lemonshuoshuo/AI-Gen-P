/**
 * 合并「加载更多」的分页结果并按 key 去重：偏移分页在两次加载之间若有新发布 / 排序变化，
 * 同一条目可能同时出现在相邻两页。保留先出现的那条，已显示的卡片不会跳位置
 */
export function dedupeBy<T>(items: T[], key: (item: T) => number | string): T[] {
  const seen = new Set<number | string>()
  return items.filter((it) => {
    const k = key(it)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** useInfiniteQuery 的各页按 id 去重合并 */
export function flattenPages<T extends { id: number }>(pages: { items: T[] }[] | undefined): T[] {
  return dedupeBy(pages?.flatMap((p) => p.items) ?? [], (it) => it.id)
}
