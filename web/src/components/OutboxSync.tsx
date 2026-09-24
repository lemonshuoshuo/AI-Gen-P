import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { flushOutbox, hasPending, listOutbox, onOutboxChange, onOutboxSent } from '@/lib/outbox'
import { useAuth } from '@/stores/auth'

const SYNC_INTERVAL = 30_000

/** 登录后在后台补发离线保存的打卡 / 照片：打开时、联网时、切回前台时，以及有待发记录时每 30 秒 */
export function OutboxSync() {
  const userId = useAuth((s) => s.user?.id)
  const qc = useQueryClient()

  useEffect(
    () =>
      onOutboxSent((item) => {
        qc.invalidateQueries({ queryKey: ['trip', String(item.tripId)] })
      }),
    [qc],
  )

  useEffect(() => {
    if (!userId) return
    const sync = () => {
      void flushOutbox(userId)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    sync()
    window.addEventListener('online', sync)
    document.addEventListener('visibilitychange', onVisible)
    const t = setInterval(() => {
      void hasPending().then((pending) => {
        if (pending) sync()
      })
    }, SYNC_INTERVAL)
    return () => {
      window.removeEventListener('online', sync)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(t)
    }
  }, [userId])

  return null
}

/** 当前用户（某个旅程）还没同步到服务器的记录数 */
export function useOutboxCount(userId: number | undefined, tripId?: number) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!userId) return
    let alive = true
    const update = () => {
      void listOutbox(userId, tripId).then((l) => {
        if (alive) setCount(l.length)
      })
    }
    update()
    const off = onOutboxChange(update)
    return () => {
      alive = false
      off()
    }
  }, [userId, tripId])
  return userId ? count : 0
}
