// 与 docs/API.md 保持一致的数据类型

export type Role = 'user' | 'admin'
export type Phase = 'planning' | 'ongoing' | 'finished'
export type Visibility = 'private' | 'unlisted' | 'public'
/** pending：开启「公开旅程需审核」后等待管理员审核，通过前仅成员和管理员可见 */
export type TripStatus = 'normal' | 'hidden' | 'pending'
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
  /** deleted：已注销（只会出现在管理后台的用户列表中） */
  status: 'active' | 'banned' | 'deleted'
  storage_used: number
  /** 0 表示不限（管理员） */
  storage_quota: number
  /** 情侣：自己所在情侣空间里的另一个人 */
  partner: UserBrief | null
  /** 默认空间：点「我们」时直接打开它；没有设置时为 null（旧版服务端没有这个字段） */
  default_space_id?: number | null
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
  /** 封面的 480px 缩略图（列表 / 卡片用；外链封面时与 cover_url 相同） */
  cover_thumb_url: string
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
  /** 旅程关联到情侣空间，或作者的情侣是共同作者 */
  together: boolean
  /** 旅程所属的空间：只返回给该空间的成员，其他人为 null */
  space?: SpaceRef | null
  author: UserBrief
  members: UserBrief[]
  created_at: string
  updated_at: string
  published_at: string | null
  /**
   * 版本号（≥ 1）：旅程及其打卡点、住宿、打卡、照片、成员每修改一次加 1（见 API.md「协同编辑」）。
   * 旅行中且未开启 live_share 时，非成员看到的是 0
   */
  revision: number
}

export interface Waypoint {
  id: number
  trip_id: number
  seq: number
  day: number
  /** stop：游玩点（缺省）；lodging：住宿，day=N 为第 N 天晚上住的地方（0 为出发前一晚） */
  kind: WaypointKind
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
  /** 仅 TripDetail：关联地点有公开打卡时的社区统计（没有时不返回） */
  place_stats?: PlaceStats
}

/** 地点的社区统计：TripDetail 中打卡点的 place_stats、/geo/search 与 /geo/around 结果的 place（含义同 Place） */
export interface PlaceStats {
  id: number
  checkin_count: number
  recommend_count: number
  neutral_count: number
  avoid_count: number
  rating_avg: number
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
  /** 当前用户有待接受的共同作者邀请（接受前可预览旅程） */
  invite_pending: boolean
  waypoints: Waypoint[]
  photos: Photo[]
  has_track: boolean
  /** 旅行中（phase=ongoing）是否向非成员实时公开打卡、照片和 GPS 轨迹；只有作者能修改 */
  live_share: boolean
  /** 偏好的出行方式（GET /trips/:id/legs 的缺省 mode），缺省 auto */
  travel_mode: TravelMode
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
  cover_thumb_url: string
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
  waypoint_id?: number
  /** 该打卡点第一张照片的缩略图（放大到城市级时显示），没有照片为空字符串 */
  photo_thumb_url?: string
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
    cover_thumb_url: string
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
  | 'space_invite'
  | 'space_accept'
  | 'space_decline'
  /** 旧版本产生的情侣邀请通知（升级后不再产生） */
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
  /** 空间相关通知的空间：只在接收者现在是成员或有待回应的邀请时返回 */
  space?: SpaceRef | null
  comment_id: number | null
  /** space_invite：邀请留言；space_accept / space_decline：跟在发起人昵称后的一句话；system：完整的一句话 */
  content: string
  read: boolean
  /** trip_invite / space_invite：邀请仍待当前用户接受 / 拒绝 */
  invite_pending?: boolean
  /** space_invite：邀请仍待回应时为邀请 ID（POST /space-invites/:id/accept、decline） */
  space_invite_id?: number | null
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
  /** 是否在双方个人主页公开显示情侣关系（双方共享，缺省 false） */
  public: boolean
  /** 自己的情侣空间（只有自己一人时也返回），没有时为 null */
  space_id?: number | null
  invites: { incoming: PartnerInvite[]; outgoing: PartnerInvite[] }
}

/* ---------------- 空间「我们」（API.md「空间」） ---------------- */

/** couple 情侣（最多 2 人）· besties 闺蜜 · friends 朋友 · family 家人 · custom 自定义 */
export type SpaceType = 'couple' | 'besties' | 'friends' | 'family' | 'custom'

/** 空间的引用（TripCard、Notification 中使用） */
export interface SpaceRef {
  id: number
  name: string
  type: SpaceType
  /** 类型的显示名称：情侣 / 闺蜜 / 朋友 / 家人，或自定义的名称（如「驴友团」），直接显示即可 */
  type_label: string
}

export interface SpaceMember extends UserBrief {
  space_role: 'owner' | 'member'
  joined_at: string
}

/** 空间里的一次旅程（Space 的 last_trip） */
export interface TripBrief {
  id: number
  title: string
  cover_url: string
  cover_thumb_url: string
  phase: Phase
  start_date: string | null
  end_date: string | null
  days: number
  cities: string[]
}

/** GET /spaces 的列表项（只有空间成员能看到） */
export interface Space extends SpaceRef {
  description: string
  /** 纪念日 YYYY-MM-DD（主要用于情侣空间） */
  anniversary: string | null
  /** 只对情侣空间有意义：是否在两人的个人主页上显示情侣关系 */
  public: boolean
  owner: UserBrief
  /** 当前用户在空间中的角色 */
  role: 'owner' | 'member'
  /** 是否是当前用户的默认空间 */
  is_default: boolean
  /** 创建者在前，其余按加入的先后 */
  members: SpaceMember[]
  member_count: number
  /** 关联到空间的旅程数（含规划中的） */
  trip_count: number
  city_count: number
  last_trip: TripBrief | null
  /** 待对方回应的邀请数 */
  pending_invite_count: number
  /** 能否修改空间设置（创建者；情侣空间的两个人都能） */
  can_manage: boolean
  /** 现在能否邀请：有邀请的权限（情侣空间为创建者，其他空间为任何成员），且还没满 */
  can_invite: boolean
  created_at: string
  updated_at: string
}

export interface SpaceInvite {
  id: number
  space: SpaceRef & { description: string; member_count: number; members: UserBrief[] }
  inviter: UserBrief
  invitee: UserBrief
  message: string
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  created_at: string
}

/** GET /spaces/:id，以及创建、修改空间与接受邀请的响应 */
export interface SpaceDetail extends Space {
  /** 同空间足迹的 stats，另加 trip_count */
  stats: Footprints['stats'] & { trip_count: number }
  /** 待回应的邀请（空间成员都能看到），按发出的先后 */
  invites: SpaceInvite[]
}

/** 创建（type 必填）/ 修改空间；anniversary: null 清除 */
export interface SpaceInput {
  type?: SpaceType
  name?: string
  /** 仅 custom：类型名称（≤10 字） */
  type_label?: string
  description?: string
  anniversary?: string | null
  /** 只有情侣空间可以设为 true */
  public?: boolean
}

export interface TripMember {
  user: UserBrief
  role: 'owner' | 'editor'
  status: 'accepted' | 'pending'
}

/* ---------------- 协同编辑（API.md「协同编辑」） ---------------- */

/** 正在编辑的成员（45 秒内发过心跳），包括请求者自己 */
export interface TripEditor {
  user: UserBrief
  since: string
  last_seen: string
}

/** GET /trips/:id/revision、POST /trips/:id/editing 的响应 */
export interface TripRevision {
  revision: number
  updated_at: string
  /** 最后修改的人：只返回给成员（含待接受邀请的人）和管理员，其他人或未知时为 null */
  updated_by: UserBrief | null
  /** 只返回给成员和管理员，其他人为 [] */
  editors: TripEditor[]
}

/**
 * PUT /trips/:id/plan 的一项：带 id 修改该打卡点（没给出的字段不变），不带 id 新建计划内的点。
 * status / planned / arrived_at / seq / place_id 会被服务端忽略（保存计划不改动打卡记录）
 */
export interface PlanItemInput extends Omit<WaypointInput, 'seq' | 'status' | 'planned' | 'arrived_at' | 'coord_type'> {
  id?: number
  /** 客户端给这一项起的名字（≤64 字符，不能重复），响应的 id_map 返回它保存后的 ID */
  client_key?: string
}

export interface PlanSaveInput {
  /** 草稿所基于的版本号；force 不为 true 时必填 */
  base_revision?: number
  /** 不检查版本，用草稿覆盖服务端的计划 */
  force?: boolean
  /** 同 PATCH /trips/:id 的请求体 */
  trip?: TripInput
  /** 完整的计划列表，顺序即新的顺序 */
  waypoints: PlanItemInput[]
}

export interface PlanSaveResult {
  trip: TripDetail
  /** client_key → 保存后的打卡点 ID */
  id_map: Record<string, number>
  /** 不在列表中、因已到达或有照片而保留的计划内的点 */
  kept: number[]
  deleted: number[]
}

/** PUT /trips/:id/plan 版本冲突（409）时响应体中除 error 之外的字段 */
export interface PlanConflict {
  revision: number
  updated_by: UserBrief | null
  updated_at: string
}

export interface SiteConfig {
  name: string
  announcement: string
  registration_open: boolean
  /** ICP 备案号 / 公安联网备案号，未填为空字符串；页脚分别链接到 https://beian.miit.gov.cn/ 与 https://beian.mps.gov.cn/ */
  icp_beian: string
  police_beian: string
  amap_search: boolean
  ai_enabled: boolean
  map: {
    /** 底图版权 / 审图号（可含 HTML），显示在地图角落；未返回时用默认的「© 高德地图」 */
    attribution?: string
    tiles: { normal: string[]; satellite: string[]; satellite_label: string[] }
  }
  levels: { level: number; name: string; min_exp: number; quota_mb: number }[]
  /** 每人每天最多可获得的经验值 */
  exp_daily_cap: number
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
  /** 该高德 POI 对应地点的社区统计；还没有公开打卡或 source=local 时为 null */
  place?: PlaceStats | null
}

/** 地图选点：点击位置附近的候选地点（景区范围 aoi > 附近 POI > 社区地点 > 该坐标本身） */
export interface GeoPickCandidate {
  kind: 'aoi' | 'poi' | 'place' | 'address'
  name: string
  address: string
  category: Category | ''
  amap_id: string
  place_id: number | null
  lng: number
  lat: number
  distance_m: number
  place?: PlaceStats | null
}

export interface GeoPickResult {
  address: { province: string; city: string; district: string; street: string; address: string }
  candidates: GeoPickCandidate[]
  source: 'amap' | 'tianditu' | 'local'
  /** 高德调用失败的原因（Key 类型不对、额度用完等），给用户和管理员看 */
  amap_error?: string
}

export type GeoSource = 'amap' | 'tianditu' | 'local'

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
  /** 住宿（不计入以上各项与完成度），按 seq */
  lodging?: Waypoint[]
  days: { day: number; planned: number; visited: number; extra: number }[]
  time_diffs: { waypoint_id: number; name: string; planned_at: string; arrived_at: string; delta_minutes: number }[]
}

export interface AIPlanItem {
  day: number
  /** lodging：第 day 天晚上的住宿（旧版服务端没有该字段，按 stop 处理） */
  kind?: WaypointKind
  name: string
  address: string
  city?: string
  district?: string
  category: Category
  note: string
  lng: number | null
  lat: number | null
  located: boolean
  amap_id: string
  place_id: number | null
}

export interface AIPlanProgress {
  stage: 'thinking' | 'writing' | 'locating'
  chars: number
  message: string
}

export interface AIPlanResult {
  title: string
  summary: string
  items: AIPlanItem[]
}

/** Key 指纹：长度与首尾几个字符，不含完整 Key */
export interface DiagKeyHint {
  length: number
  head?: string
  tail?: string
  whitespace?: boolean
  quotes?: boolean
  non_ascii?: boolean
  non_hex?: boolean
  /** 与常见格式不符时的提示 */
  warning?: string
  /** 如「长度 32 · c549…bd36」 */
  text: string
}

/** 服务器进程的代理环境变量（已去掉账号密码） */
export interface DiagProxy {
  https_proxy?: string
  http_proxy?: string
  no_proxy?: string
  /** 访问该服务实际经过的代理，缺省为直连 */
  used?: string
}

/**
 * 失败环节：dns / proxy / connect / tls / timeout / network 为没连上服务；http / api / response 为服务返回了错误；
 * slow 为 AI 已开始返回但没有在时限内完成（模型慢，不是网络问题）
 */
export type DiagLayer = 'dns' | 'proxy' | 'connect' | 'tls' | 'timeout' | 'network' | 'http' | 'api' | 'response' | 'slow'

/** 检测的技术细节（均为可选，旧版服务端没有；不含任何 Key） */
export interface DiagDetail {
  host?: string
  layer?: DiagLayer
  /** 失败时的 HTTP 状态码 */
  status?: number
  /** 原始错误或服务商返回的信息（Key 已替换为 ***） */
  detail?: string
  /** 服务域名解析到的地址 */
  addrs?: string[]
  /** 经代理访问时，代理主机名解析到的地址 */
  proxy_addrs?: string[]
  /** 已连接的对端地址（经代理时为代理的地址） */
  remote?: string
  /** 返回的不是服务商自己的错误信息（代理、防火墙、WAF 页面），与 Key 无关 */
  blocked?: boolean
  /** 只有设置了代理环境变量时才有 */
  proxy?: DiagProxy
  key_hint?: DiagKeyHint
}

export interface AdminDiagnostics {
  amap: DiagDetail & { configured: boolean; ok: boolean; message: string; infocode?: string; latency_ms: number }
  ai: DiagDetail & {
    configured: boolean
    ok: boolean
    model: string
    base_url: string
    thinking: string
    timeout_s: number
    latency_ms: number
    message: string
    /** auth / balance / model / rate_limit / server / network / timeout … */
    kind?: string
  }
  tianditu: DiagDetail & { configured: boolean; ok: boolean; message: string; latency_ms: number }
}

export interface AdminStats {
  users: number
  trips: number
  public_trips: number
  /** 待审核的公开旅程数 */
  pending_trips: number
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
  kind?: WaypointKind
  /** 创建时的位置提示（如来自 /geo/search）：地址和区县都给了就不必再逆地理；district 优先使用，province / city 仅在坐标不在离线行政区划内时使用 */
  province?: string
  city?: string
  district?: string
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
  /** 仅创建时：把情侣加为共同作者（没给 space_id 时同时关联到情侣空间） */
  with_partner?: boolean
  /** 旅程所属的空间（null / 0 表示不属于任何空间）：加入或更换只有作者可以，移出为作者或空间创建者 */
  space_id?: number | null
  /** 仅作者可改（否则 403） */
  live_share?: boolean
  /** 规划的天数（0–365，0 / null 表示不再指定）；有开始日期时同时改结束日期 */
  days?: number | null
  travel_mode?: TravelMode
}

/** 管理后台站点设置（GET / PUT /admin/settings，PUT 字段均可选，返回保存后的全部设置） */
export interface AdminSettings {
  site_name: string // ≤30
  announcement: string // ≤500
  registration_open: boolean
  icp_beian: string // ≤50
  police_beian: string // ≤60
  /** Markdown ≤20000 字；空字符串表示使用内置模板；可用 {{site}} 表示站点名称 */
  terms_md: string
  privacy_md: string
  /** 屏蔽词：每行一个，也可用逗号分隔（≤100000 字） */
  sensitive_words: string
  review_public_trips: boolean
}

/* ---------------- 按天规划：住宿、出行方式、路段、一键排路线（v1.3） ---------------- */

/** stop：游玩点；lodging：住宿（第 day 天晚上，0 为出发前一晚） */
export type WaypointKind = 'stop' | 'lodging'

/** 旅程偏好的出行方式：auto 每段按距离推荐（步行 / 骑行 / 驾车） */
export type TravelMode = 'auto' | 'walking' | 'riding' | 'driving' | 'transit'

/** 一段路实际采用的出行方式 */
export type LegMode = Exclude<TravelMode, 'auto'>

/** 每天路线（前一晚住宿 → 当天计划游玩点 → 当晚住宿）中相邻两点之间的一段（GET /trips/:id/legs） */
export interface TripLeg {
  /** 可以是住宿的 ID */
  from_id: number
  to_id: number
  day: number
  /** 实际采用的方式：auto 为推荐的方式；transit 下很近或查不到公交地铁的路段为 walking */
  mode: LegMode
  /** 推荐的出行方式：直线 1.2 公里内步行、4 公里内骑行，更远驾车（旅程偏好公交时为公交） */
  recommended_mode: LegMode
  distance_m: number
  duration_s: number
  straight_m: number
  /** 按直线距离估算（未配置高德 Key、调用失败或超时） */
  estimated: boolean
  /** 仅 geometry=1：实际路线 [[lng, lat], …]（GCJ-02，已抽稀）；估算的路段为起终点直线 */
  polyline?: [number, number][]
}

export interface DayLegs {
  day: number
  /** 当天的计划游玩点数（不含住宿） */
  stops: number
  distance_m: number
  /** 路上用时，不含停留游玩 */
  duration_s: number
  estimated: boolean
  /** 当天出发 / 结束的住宿，没有时为 null */
  start_lodging_id?: number | null
  end_lodging_id?: number | null
}

export interface TripLegs {
  /** 请求（或缺省）的方式 */
  mode: TravelMode
  legs: TripLeg[]
  /** 按天排序，day=0（未分天）排在最后 */
  days: DayLegs[]
  /** 还没算好的路段数：大于 0 时 3–5 秒后用同样的参数再请求 */
  pending?: number
}

/** POST /trips/:id/lodging：打卡点字段 + 从第几晚开始、连住几晚、沿用哪个点 */
export interface LodgingInput extends Omit<WaypointInput, 'kind' | 'seq' | 'day'> {
  /** 第几天晚上（0 为出发前一晚） */
  day: number
  /** 连住几晚（1–30，缺省 1） */
  nights?: number
  /** 沿用同一旅程中另一个点（如前一晚的住宿）的名称、地址、坐标等 */
  copy_from?: number
  /** 先删除这几晚已有的住宿；为 false 且已有住宿时 409 */
  replace?: boolean
}

/** pool：只安排「想去」（day=0）的地点；all：重新安排全部未到达的计划点 */
export type ArrangeScope = 'pool' | 'all'

export interface ArrangeInput {
  scope?: ArrangeScope
  mode?: TravelMode
  /** false（缺省）只返回方案预览 */
  apply?: boolean
  days?: number
  /** { 打卡点 ID: 第几天 } */
  fixed?: Record<string, number>
}

export interface ArrangeDay {
  day: number
  /** 当天安排的游玩点（按顺序，不含住宿） */
  ids: number[]
  stops: number
  /** 按直线估算 */
  distance_m: number
  duration_s: number
  start_lodging_id: number | null
  end_lodging_id: number | null
}

export interface ArrangeResult {
  scope: ArrangeScope
  mode: TravelMode
  days: number
  applied: boolean
  /** day 或 seq 会变化的点数 */
  changed: number
  /** 全部打卡点（含住宿）在新顺序中的 day 与 seq，按 seq */
  items: { id: number; day: number; seq: number }[]
  day_totals: ArrangeDay[]
  /** 仅 apply=true：保存后的全部打卡点 */
  waypoints?: Waypoint[]
}

/** POST /ai/preferences：AI 帮写「偏好和要求」 */
export interface AIPreferencesInput {
  destination: string
  days?: number
  start_date?: string
  together?: boolean
  /** 用户已写的偏好（≤300 字） */
  draft?: string
}

export interface AIPreferencesResult {
  /** 可点击追加的短句 */
  suggestions: string[]
  /** 整合后的一段偏好，可能为空 */
  text: string
}

/** POST /trips/:id/track/import 的结果 */
export interface TrackImportResult {
  accepted: number
  total_points: number
  distance_km: number
  segments: number
}
