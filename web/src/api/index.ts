import { http } from './client'
import type {
  AdminStats,
  AdminUser,
  AIPlanResult,
  AuthResult,
  Comment,
  CompareResult,
  CoordType,
  Footprints,
  GeoSearchItem,
  Me,
  Notification,
  Paged,
  PartnerInfo,
  PartnerInvite,
  Phase,
  Photo,
  Place,
  PlaceReview,
  Recommendation,
  Regeo,
  Report,
  SiteConfig,
  TrackData,
  TrackPointIn,
  TripCard,
  TripDetail,
  TripInput,
  TripMember,
  UserBrief,
  UserProfile,
  Waypoint,
  WaypointInput,
} from './types'

export * from './types'
export { ApiError, errorMessage, isNotFound } from './client'

type PageQuery = { page?: number; page_size?: number }

export const api = {
  site: () => http.get<SiteConfig>('/site'),
  /** 用户协议（terms）/ 隐私政策（privacy），Markdown */
  legal: (doc: 'terms' | 'privacy') => http.get<{ content: string }>(`/site/legal/${doc}`),

  auth: {
    /** agree_terms：已阅读并同意用户协议和隐私政策（服务端要求为 true） */
    register: (b: { username: string; password: string; email?: string; nickname?: string; agree_terms: boolean }) =>
      http.post<AuthResult>('/auth/register', b),
    login: (b: { account: string; password: string }) => http.post<AuthResult>('/auth/login', b),
    logout: (refresh_token: string) => http.post<unknown>('/auth/logout', { refresh_token }),
  },

  me: {
    get: () => http.get<Me>('/me'),
    update: (b: Partial<Pick<Me, 'nickname' | 'bio' | 'avatar_url' | 'email'>>) => http.patch<Me>('/me', b),
    password: (b: { old_password: string; new_password: string }) => http.post<unknown>('/me/password', b),
    avatar: (file: Blob) => {
      const f = new FormData()
      f.append('file', file, 'avatar.jpg')
      return http.upload<{ avatar_url: string }>('/me/avatar', f)
    },
    trips: (q: PageQuery & { phase?: Phase | ''; visibility?: string }) => http.get<Paged<TripCard>>('/me/trips', q),
    favorites: (q: PageQuery) => http.get<Paged<TripCard>>('/me/favorites', q),
    footprints: () => http.get<Footprints>('/me/footprints'),
    invites: () =>
      http.get<{
        trip_invites: { trip: TripCard; from: UserBrief; created_at: string }[]
        partner_invites: PartnerInvite[]
      }>('/me/invites'),
  },

  users: {
    get: (username: string) => http.get<UserProfile>(`/users/${encodeURIComponent(username)}`),
    trips: (username: string, q: PageQuery) =>
      http.get<Paged<TripCard>>(`/users/${encodeURIComponent(username)}/trips`, q),
    footprints: (username: string) => http.get<Footprints>(`/users/${encodeURIComponent(username)}/footprints`),
    follow: (username: string) =>
      http.post<{ following: boolean; followers: number }>(`/users/${encodeURIComponent(username)}/follow`),
    unfollow: (username: string) =>
      http.del<{ following: boolean; followers: number }>(`/users/${encodeURIComponent(username)}/follow`),
    followers: (username: string, q: PageQuery) =>
      http.get<Paged<UserBrief>>(`/users/${encodeURIComponent(username)}/followers`, q),
    following: (username: string, q: PageQuery) =>
      http.get<Paged<UserBrief>>(`/users/${encodeURIComponent(username)}/following`, q),
  },

  trips: {
    list: (
      q: PageQuery & {
        tab?: string
        q?: string
        tag?: string
        province?: string
        city?: string
        phase?: Phase | ''
      },
    ) => http.get<Paged<TripCard>>('/trips', q),
    create: (b: TripInput) => http.post<TripDetail>('/trips', b),
    get: (id: number | string) => http.get<TripDetail>(`/trips/${id}`),
    byShare: (code: string) => http.get<TripDetail>(`/share/${encodeURIComponent(code)}`),
    update: (id: number, b: TripInput) => http.patch<TripDetail>(`/trips/${id}`, b),
    remove: (id: number) => http.del<unknown>(`/trips/${id}`),
    fork: (id: number, title?: string) => http.post<TripDetail>(`/trips/${id}/fork`, { title }),
    like: (id: number, on: boolean) =>
      on
        ? http.post<{ liked: boolean; like_count: number }>(`/trips/${id}/like`)
        : http.del<{ liked: boolean; like_count: number }>(`/trips/${id}/like`),
    favorite: (id: number, on: boolean) =>
      on
        ? http.post<{ favorited: boolean; fav_count: number }>(`/trips/${id}/favorite`)
        : http.del<{ favorited: boolean; fav_count: number }>(`/trips/${id}/favorite`),
    resetShareCode: (id: number) => http.post<{ share_code: string }>(`/trips/${id}/share-code/reset`),
    members: (id: number) => http.get<TripMember[]>(`/trips/${id}/members`),
    invite: (id: number, username: string) => http.post<unknown>(`/trips/${id}/members`, { username }),
    removeMember: (id: number, userId: number) => http.del<unknown>(`/trips/${id}/members/${userId}`),
    acceptInvite: (id: number) => http.post<TripDetail>(`/trips/${id}/members/accept`),
    declineInvite: (id: number) => http.post<unknown>(`/trips/${id}/members/decline`),
    track: (id: number, max = 2000) => http.get<TrackData>(`/trips/${id}/track`, { max }),
    appendTrack: (id: number, points: TrackPointIn[], segment = 0) =>
      http.post<{ accepted: number; total_points: number; distance_km: number }>(`/trips/${id}/track`, {
        coord_type: 'wgs84',
        segment,
        points,
      }),
    clearTrack: (id: number) => http.del<unknown>(`/trips/${id}/track`),
    checkin: (
      id: number,
      b: {
        lng?: number
        lat?: number
        coord_type?: CoordType
        name?: string
        address?: string
        amap_id?: string
        category?: string
        note?: string
        waypoint_id?: number | null
        arrived_at?: string
        /** 客户端生成的幂等键：离线补发时服务端按它去重 */
        client_id?: string
      },
    ) => http.post<{ waypoint: Waypoint; matched_plan: boolean }>(`/trips/${id}/checkin`, b),
    recommend: (id: number, q: { lng?: number; lat?: number; coord_type?: CoordType; ai?: boolean }) =>
      http.get<Recommendation>(`/trips/${id}/recommend`, q),
    compare: (id: number) => http.get<CompareResult>(`/trips/${id}/compare`),
    comments: (id: number, q: PageQuery & { waypoint_id?: number }) =>
      http.get<Paged<Comment>>(`/trips/${id}/comments`, q),
    addComment: (id: number, b: { content: string; parent_id?: number | null; waypoint_id?: number | null }) =>
      http.post<Comment>(`/trips/${id}/comments`, b),
  },

  waypoints: {
    create: (tripId: number, b: WaypointInput) => http.post<Waypoint>(`/trips/${tripId}/waypoints`, b),
    batch: (tripId: number, items: WaypointInput[]) =>
      http.post<Waypoint[]>(`/trips/${tripId}/waypoints/batch`, { items }),
    update: (id: number, b: WaypointInput) => http.patch<Waypoint>(`/waypoints/${id}`, b),
    remove: (id: number) => http.del<unknown>(`/waypoints/${id}`),
    order: (tripId: number, ids: number[]) => http.put<Waypoint[]>(`/trips/${tripId}/waypoints/order`, { ids }),
    checkin: (id: number, arrived_at?: string) => http.post<Waypoint>(`/waypoints/${id}/checkin`, { arrived_at }),
    skip: (id: number) => http.post<Waypoint>(`/waypoints/${id}/skip`),
    reset: (id: number) => http.post<Waypoint>(`/waypoints/${id}/reset`),
  },

  photos: {
    upload: (
      tripId: number,
      file: Blob,
      meta: {
        filename?: string
        lng?: number
        lat?: number
        coord_type?: CoordType
        taken_at?: string
        caption?: string
        waypoint_id?: number
        auto_waypoint?: boolean
        /** 客户端生成的幂等键：离线补发时服务端按它去重 */
        client_id?: string
      },
      onProgress?: (r: number) => void,
    ) => {
      const f = new FormData()
      f.append('file', file, meta.filename ?? 'photo.jpg')
      if (meta.lng != null && meta.lat != null) {
        f.append('lng', String(meta.lng))
        f.append('lat', String(meta.lat))
        f.append('coord_type', meta.coord_type ?? 'wgs84')
      }
      if (meta.taken_at) f.append('taken_at', meta.taken_at)
      if (meta.caption) f.append('caption', meta.caption)
      if (meta.waypoint_id) f.append('waypoint_id', String(meta.waypoint_id))
      if (meta.auto_waypoint) f.append('auto_waypoint', 'true')
      if (meta.client_id) f.append('client_id', meta.client_id)
      return http.upload<{ photo: Photo; waypoint: Waypoint | null; waypoint_created: boolean }>(
        `/trips/${tripId}/photos`,
        f,
        onProgress,
      )
    },
    update: (id: number, b: { caption?: string; waypoint_id?: number }) => http.patch<Photo>(`/photos/${id}`, b),
    remove: (id: number) => http.del<unknown>(`/photos/${id}`),
    uploadImage: (file: Blob, filename = 'image.jpg') => {
      const f = new FormData()
      f.append('file', file, filename)
      return http.upload<{ url: string; thumb_url: string; width: number; height: number }>('/uploads/image', f)
    },
  },

  comments: {
    remove: (id: number) => http.del<unknown>(`/comments/${id}`),
  },

  places: {
    list: (q: PageQuery & { q?: string; city?: string; category?: string; sort?: string }, signal?: AbortSignal) =>
      http.get<Paged<Place>>('/places', q, signal),
    nearby: (q: { lng: number; lat: number; radius?: number; limit?: number }) =>
      http.get<Place[]>('/places/nearby', q),
    get: (id: number | string) => http.get<Place>(`/places/${id}`),
    reviews: (id: number, q: PageQuery & { verdict?: string }) =>
      http.get<Paged<PlaceReview>>(`/places/${id}/reviews`, q),
    comments: (id: number, q: PageQuery) => http.get<Paged<Comment>>(`/places/${id}/comments`, q),
    addComment: (id: number, b: { content: string; parent_id?: number | null }) =>
      http.post<Comment>(`/places/${id}/comments`, b),
  },

  geo: {
    search: (q: { keyword: string; city?: string; lng?: number; lat?: number }, signal?: AbortSignal) =>
      http.get<{ source: 'amap' | 'local'; items: GeoSearchItem[] }>('/geo/search', q, signal),
    regeo: (q: { lng: number; lat: number; coord_type?: CoordType }) => http.get<Regeo>('/geo/regeo', q),
    /** 周边地点（GCJ-02 坐标）；服务器未配置高德 Key 时 source 为 none */
    around: (q: { lng: number; lat: number; radius?: number; keyword?: string }, signal?: AbortSignal) =>
      http.get<{ source: 'amap' | 'none'; items: (GeoSearchItem & { distance_m: number })[] }>('/geo/around', q, signal),
  },

  partner: {
    get: () => http.get<PartnerInfo>('/partner'),
    update: (b: { since?: string | null; title?: string }) => http.patch<PartnerInfo>('/partner', b),
    unbind: () => http.del<unknown>('/partner'),
    invite: (username: string, message?: string) => http.post<PartnerInvite>('/partner/invites', { username, message }),
    accept: (id: number) => http.post<unknown>(`/partner/invites/${id}/accept`),
    decline: (id: number) => http.post<unknown>(`/partner/invites/${id}/decline`),
    cancel: (id: number) => http.del<unknown>(`/partner/invites/${id}`),
    trips: (q: PageQuery) => http.get<Paged<TripCard>>('/partner/trips', q),
    footprints: () => http.get<Footprints>('/partner/footprints'),
  },

  notifications: {
    list: (q: PageQuery & { unread_only?: boolean }) => http.get<Paged<Notification>>('/notifications', q),
    unreadCount: () => http.get<{ count: number }>('/notifications/unread-count'),
    read: (ids?: number[]) => http.post<unknown>('/notifications/read', ids ? { ids } : {}),
  },

  reports: {
    create: (b: { target_type: string; target_id: number; reason: string }) => http.post<{ id: number }>('/reports', b),
  },

  ai: {
    plan: (b: { destination: string; days: number; preferences?: string; start_date?: string }) =>
      http.post<AIPlanResult>('/ai/plan', b),
  },

  admin: {
    stats: () => http.get<AdminStats>('/admin/stats'),
    users: (q: PageQuery & { q?: string; role?: string; status?: string }) =>
      http.get<Paged<AdminUser>>('/admin/users', q),
    updateUser: (id: number, b: { role?: string; status?: string; exp?: number }) =>
      http.patch<AdminUser>(`/admin/users/${id}`, b),
    trips: (q: PageQuery & { q?: string; status?: string; visibility?: string }) =>
      http.get<Paged<TripCard>>('/admin/trips', q),
    updateTrip: (id: number, b: { featured?: boolean; status?: string }) =>
      http.patch<TripCard>(`/admin/trips/${id}`, b),
    deleteTrip: (id: number) => http.del<unknown>(`/admin/trips/${id}`),
    comments: (q: PageQuery & { q?: string }) => http.get<Paged<Comment>>('/admin/comments', q),
    deleteComment: (id: number) => http.del<unknown>(`/admin/comments/${id}`),
    reports: (q: PageQuery & { status?: string }) => http.get<Paged<Report>>('/admin/reports', q),
    updateReport: (id: number, b: { status: string; note?: string }) => http.patch<Report>(`/admin/reports/${id}`, b),
    settings: () => http.get<{ site_name: string; announcement: string; registration_open: boolean }>('/admin/settings'),
    saveSettings: (b: { site_name: string; announcement: string; registration_open: boolean }) =>
      http.put<unknown>('/admin/settings', b),
  },
}
