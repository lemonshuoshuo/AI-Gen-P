import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'

export function useSite() {
  return useQuery({ queryKey: ['site'], queryFn: api.site, staleTime: 5 * 60_000 })
}
