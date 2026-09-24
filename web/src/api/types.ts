// 与 docs/API.md 保持一致的数据类型

export type Role = 'user' | 'admin'
export type Phase = 'planning' | 'ongoing' | 'finished'
export type Visibility = 'private' | 'unlisted' | 'public'
export type TripStatus = 'normal' | 'hidden'
export type Category = 'scenic' | 'food' | 'hotel' | 'shopping' | 'transport' | 'entertainment' | 'other'
export type Verdict = 'recommend' | 'neutral' | 'avoid' | ''
export type WaypointStatus = 'todo' | 'visited' | 'skipped'
export type CoordType = 'gcj02' | 'wgs84'

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface UserBrief {
  id: number
  username: string
  nickname: string
  avatar_url: string
  level: number
  role: Role
}

export interface Me extends UserBrief {
  email: string
  bio: string
  exp: number
  level_name: string
  /** 满级时为 null */
  next_level_exp: number | null
  status: 'active' | 'banned'
  storage_used: number
  /** 0 表示不限（管理员） */
  storage_quota: number
  partner: UserBrief | null
  created_at: string
}

export interface UserProfile extends UserBrief {
  bio: string
  level_name: string
  exp: number
  created_at: string
  stats: { trips: number; followers: number; following: number; likes: number }
  is_following: boolean
  is_me: boolean
  partner: UserBrief | null
}

export interface AuthResult {
  user: Me
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface TripCard {
  id: number
  title: string
  summary: string
  cover_url: string
  phase: Phase
  visibility: Visibility
  status: TripStatus
  start_date: string | null
  end_date: string | null
  days: number
  distance_km: number
  cities: string[]
  provinces: string[]
  tags: string[]
  waypoint_count: number
  planned_count: number
  visited_count: number
  photo_count: number
  like_count: number
  comment_count: number
  fork_count: number
  fav_count: number
  view_count: number
  featured: boolean
  together: boolean
  author: UserBrief
  members: UserBrief[]
  created_at: string
  updated_at: string
  published_at: string | null
}

export interface Waypoint {
  id: number
  trip_id: number
  seq: number
  day: number
  planned: boolean
  status: WaypointStatus
  planned_at: string | null
  name: string
  address: string
  province: string
  city: string
  district: string
  lng: number
  lat: number
  category: Category
  arrived_at: string | null
  note: string
  verdict: Verdict
  rating: number
  cost: number
  amap_id: string
  place_id: number | null
  created_at: string
  updated_at: string
}

export interface Photo {
  id: number
  trip_id: number
  waypoint_id: number | null
  url: string
  thumb_url: string
  width: number
  height: number
  taken_at: string | null
  lng: number | null
  lat: number | null
  caption: string
  created_at: string
}

export interface TripDetail extends TripCard {
  content: string
  share_code?: string
  forked_from: { id: number; title: string; author: UserBrief } | null
  liked: boolean
  favorited: boolean
  can_edit: boolean
  is_owner: boolean
  waypoints: Waypoint[]
  photos: Photo[]
  has_track: boolean
}

export interface Place {
  id: number
  amap_id: string
  name: string
  address: string
  province: string
  city: string
  district: string
  lng: number
  lat: number
  category: Category
  tel: string
  checkin_count: number
  rating_avg: number
  rating_count: number
  recommend_count: number
  neutral_count: number
  avoid_count: number
  avg_cost: number
  comment_count: number
  cover_url: string
  created_at: string
  distance_m?: number
}

export interface PlaceReview {
  waypoint: Waypoint
  photos: Photo[]
  trip: { id: number; title: string }
  author: UserBrief
}

export interface Comment {
  id: number
  trip_id: number | null
  place_id: number | null
  waypoint_id: number | null
  parent_id: number | null
  content: string
  deleted: boolean
  author: UserBrief
  reply_to: UserBrief | null
  can_delete: boolean
  created_at: string
  replies?: Comment[]
  trip?: { id: number; title: string } | null
  place?: { id: number; name: string } | null
}

export interface FootprintPoint {
  lng: number
  lat: number
  name: string
  city: string
  province: string
  category: Category
  verdict: Verdict
  trip_id: number
  trip_title: string
  date: string | null
}

export interface Footprints {
  stats: {
    trips: number
    waypoints: number
    photos: number
    distance_km: number
    days: number
    cities: number
    provinces: number
    first_date: string | null
    last_date: string | null
  }
  points: FootprintPoint[]
  provinces: { code: string; name: string; count: number }[]
  cities: { code: string; name: string; province: string; count: number; lng: number; lat: number }[]
  trips: {
    id: number
    title: string
    start_date: string | null
    end_date: string | null
    cover_url: string
    distance_km: number
    path: [number, number][]
  }[]
}

export type NotificationType =
  | 'comment'
  | 'reply'
  | 'like'
  | 'favorite'
  | 'fork'
  | 'follow'
  | 'trip_invite'
  | 'partner_invite'
  | 'partner_accept'
  | 'featured'
  | 'system'

export interface Notification {
  id: number
  type: NotificationType
  actor: UserBrief | null
  trip: { id: number; title: string } | null
  place: { id: number; name: string } | null
  comment_id: number | null
  content: string
  read: boolean
  created_at: string
}

export interface PartnerInvite {
  id: number
  from: UserBrief
  to: UserBrief
  message: string
  status: string
  created_at: string
}

export interface PartnerInfo {
  partner: UserBrief | null
  since: string | null
  title: string
  bound_at: string | null
  invites: { incoming: PartnerInvite[]; outgoing: PartnerInvite[] }
}

export interface TripMember {
  user: UserBrief
  role: 'owner' | 'editor'
  status: 'accepted' | 'pending'
}

export interface SiteConfig {
  name: string
  announcement: string
  registration_open: boolean
  amap_search: boolean
  ai_enabled: boolean
  map: { tiles: { normal: string[]; satellite: string[]; satellite_label: string[] } }
  levels: { level: number; name: string; min_exp: number; quota_mb: number }[]
  upload: { max_photo_mb: number }
}

export interface GeoSearchItem {
  amap_id: string
  name: string
  address: string
  province: string
  city: string
  district: string
  category: Category | ''
  lng: number
  lat: number
}

export interface Regeo {
  province: string
  province_code: string
  city: string
  city_code: string
  district: string
  street: string
  address: string
  lng: number
  lat: number
}

export interface TrackData {
  segments: [number, number, number, number][][]
  point_count: number
  distance_km: number
  started_at: string | null
  ended_at: string | null
}

export interface TrackPointIn {
  lng: number
  lat: number
  alt?: number
  acc?: number
  speed?: number
  t: number
}

export interface Suggestion {
  name: string
  address: string
  lng: number
  lat: number
  category: Category
  distance_m: number
  reason: string
  source: 'plan' | 'community' | 'amap' | 'ai'
  place_id: number | null
  amap_id: string
  rating_avg?: number
}

export interface Recommendation {
  next_planned: Waypoint | null
  next_planned_distance_m: number | null
  suggestions: Suggestion[]
  warnings: { place_id: number; name: string; distance_m: number; reason: string }[]
  ai_text: string | null
  ai_used: boolean
}

export interface CompareResult {
  planned: { count: number; distance_km: number; path: [number, number][] }
  actual: { count: number; distance_km: number; track_distance_km: number; path: [number, number][] }
  completion_rate: number
  visited: Waypoint[]
  skipped: Waypoint[]
  todo: Waypoint[]
  extra: Waypoint[]
  days: { day: number; planned: number; visited: number; extra: number }[]
  time_diffs: { waypoint_id: number; name: string; planned_at: string; arrived_at: string; delta_minutes: number }[]
}

export interface AIPlanItem {
  day: number
  name: string
  address: string
  category: Category
  note: string
  lng: number | null
  lat: number | null
  located: boolean
  amap_id: string
  place_id: number | null
}

export interface AIPlanResult {
  title: string
  summary: string
  items: AIPlanItem[]
}

export interface AdminStats {
  users: number
  trips: number
  public_trips: number
  places: number
  photos: number
  comments: number
  storage_bytes: number
  today: { users: number; trips: number; comments: number }
  trend: { date: string; users: number; trips: number; comments: number }[]
}

export interface AdminUser extends Me {
  trip_count: number
  last_login_at: string | null
}

export interface Report {
  id: number
  reporter: UserBrief
  target_type: 'trip' | 'comment' | 'user' | 'place'
  target_id: number
  target_preview: string
  reason: string
  status: 'pending' | 'resolved' | 'rejected'
  note: string
  created_at: string
  handled_at: string | null
}

export interface WaypointInput {
  name?: string
  address?: string
  lng?: number
  lat?: number
  coord_type?: CoordType
  day?: number
  category?: Category
  planned?: boolean
  status?: WaypointStatus
  planned_at?: string | null
  arrived_at?: string | null
  note?: string
  verdict?: Verdict
  rating?: number
  cost?: number
  amap_id?: string
  seq?: number
}

export interface TripInput {
  title?: string
  summary?: string
  content?: string
  cover_url?: string
  phase?: Phase
  visibility?: Visibility
  start_date?: string | null
  end_date?: string | null
  tags?: string[]
  with_partner?: boolean
}
