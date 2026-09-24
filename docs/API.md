# TripHub API v1

网页端与后续 App 共用同一套 REST API。所有核心数据保存在服务端，客户端只负责展示与交互。

## 通用约定

- 基础路径：`/api/v1`
- 数据格式：JSON（上传文件用 `multipart/form-data`）
- 鉴权：`Authorization: Bearer <access_token>`。标注 🔓 的接口游客可访问，🔐 需要登录，🛡 需要管理员。
- 时间：RFC3339 字符串（如 `2026-09-24T10:00:00+08:00`）；日期：`YYYY-MM-DD`；轨迹点时间戳用 Unix 毫秒整数。
- 坐标：**所有响应中的坐标均为 GCJ-02（高德坐标系）**，`lng` 经度、`lat` 纬度。
  请求中带坐标的接口可传 `coord_type`：`gcj02`（默认）或 `wgs84`（GPS / 照片 EXIF 原始坐标），服务端会自动转换。
- 文件 URL：以 `/uploads/...` 开头的相对路径，客户端需拼接站点地址（App 端）。
- ID：64 位整数，JSON 中为 number。
- 错误响应：HTTP 状态码 + 统一结构

```json
{ "error": { "code": "bad_request", "message": "用户名已被占用" } }
```

| code | HTTP | 说明 |
|---|---|---|
| bad_request | 400 | 参数错误（message 可直接展示给用户） |
| unauthorized | 401 | 未登录或 token 失效（客户端应尝试 refresh） |
| forbidden | 403 | 无权限 / 账号被封禁 |
| not_found | 404 | 资源不存在或不可见 |
| conflict | 409 | 冲突（如重复） |
| payload_too_large | 413 | 文件过大 / 超出存储配额 |
| too_many_requests | 429 | 请求过于频繁 |
| internal | 500 | 服务器错误 |

- 分页：`?page=1&page_size=20`（page_size 最大 50），响应：

```json
{ "items": [], "total": 0, "page": 1, "page_size": 20 }
```

## 数据对象

### UserBrief
```json
{ "id": 1, "username": "lemon", "nickname": "柠檬", "avatar_url": "/uploads/..", "level": 2, "role": "user" }
```
`role`: `user` | `admin`

### Me（当前用户）
UserBrief + 
```json
{
  "email": "a@b.com", "bio": "", "exp": 120, "level_name": "背包客",
  "next_level_exp": 200, "status": "active",
  "storage_used": 1024, "storage_quota": 1073741824,
  "partner": UserBrief | null,
  "created_at": "..."
}
```
`status`: `active` | `banned`

### UserProfile
UserBrief +
```json
{
  "bio": "", "level_name": "背包客", "exp": 120, "created_at": "...",
  "stats": { "trips": 3, "followers": 10, "following": 2, "likes": 45 },
  "is_following": false, "is_me": false,
  "partner": UserBrief | null
}
```

### TripCard（列表项）
```json
{
  "id": 1, "title": "杭州三日", "summary": "…（最多120字）", "cover_url": "/uploads/..",
  "phase": "finished", "visibility": "public", "status": "normal",
  "start_date": "2026-05-01", "end_date": "2026-05-03", "days": 3,
  "distance_km": 42.5, "cities": ["杭州市"], "provinces": ["浙江省"], "tags": ["美食", "情侣"],
  "waypoint_count": 12, "planned_count": 10, "visited_count": 9, "photo_count": 30,
  "like_count": 5, "comment_count": 2, "fork_count": 1, "fav_count": 3, "view_count": 100,
  "featured": false, "together": true,
  "author": UserBrief, "members": [UserBrief],
  "created_at": "...", "updated_at": "...", "published_at": "..." | null
}
```
- `phase`: `planning`（规划中，可作为路线攻略分享） | `ongoing`（旅行中） | `finished`（已完成，游记）
- `planned_count`：计划内打卡点数；`visited_count`：已到达的打卡点数（含计划外）
- `visibility`: `private`（仅成员） | `unlisted`（持分享链接可看，不出现在广场） | `public`（公开）
- `status`: `normal` | `hidden`（被管理员隐藏，仅成员和管理员可见）
- `members`: 除作者外已接受邀请的共同作者
- `together`: 作者与其情侣都是该旅程成员时为 true

### TripDetail
TripCard +
```json
{
  "content": "正文（Markdown）",
  "share_code": "a8Kd92LmQx",
  "forked_from": { "id": 3, "title": "…", "author": UserBrief } | null,
  "liked": false, "favorited": false, "can_edit": true, "is_owner": true,
  "waypoints": [Waypoint], "photos": [Photo], "has_track": true
}
```
`share_code` 仅成员可见。

### Waypoint（打卡点）
```json
{
  "id": 1, "trip_id": 1, "seq": 0, "day": 1,
  "planned": true, "status": "visited", "planned_at": "…" | null,
  "name": "楼外楼(孤山路店)", "address": "孤山路30号",
  "province": "浙江省", "city": "杭州市", "district": "西湖区",
  "lng": 120.14, "lat": 30.25,
  "category": "food",
  "arrived_at": "..." | null,
  "note": "备注 / 攻略 / 避雷提示",
  "verdict": "recommend", "rating": 4, "cost": 150,
  "amap_id": "B023B0J1V1", "place_id": 8,
  "created_at": "...", "updated_at": "..."
}
```
- `seq`: 旅程内顺序（从 0 开始，计划内与计划外打卡点共用一个序列）；`day`: 第几天（0 表示未指定）
- `planned`: 是否属于计划路线；`status`: `todo`（计划中，未到达） | `visited`（已到达） | `skipped`（跳过）。计划外的点总是 `visited`
- `planned_at`: 计划到达时间（可选）；`arrived_at`: 实际到达时间
- **计划路线** = `planned=true` 的点按 `seq`；**实际路线** = `status=visited` 的点按 `arrived_at`（为空时按 `seq`），加上 GPS 轨迹
- 足迹统计、点亮省市、地点（Place）聚合只计入 `status=visited` 的打卡点
- `category`: `scenic`（景点） | `food`（美食） | `hotel`（住宿） | `shopping`（购物） | `transport`（交通） | `entertainment`（娱乐） | `other`
- `verdict`: `recommend`（推荐） | `neutral`（一般） | `avoid`（踩雷） | `""`（未评价）
- `rating`: 0–5（0 表示未评分）；`cost`: 人均花费（元，0 表示未填）
- `place_id`: 关联的地点（见 Place），可为 null

### Photo
```json
{
  "id": 1, "trip_id": 1, "waypoint_id": 3 | null,
  "url": "/uploads/2026/09/xxx.jpg", "thumb_url": "/uploads/2026/09/xxx_t.jpg",
  "width": 2560, "height": 1920, "taken_at": "..." | null,
  "lng": 120.1 | null, "lat": 30.2 | null, "caption": "", "created_at": "..."
}
```

### Place（地点 / 店铺，跨用户聚合）
```json
{
  "id": 8, "amap_id": "B023B0J1V1", "name": "楼外楼(孤山路店)",
  "address": "孤山路30号", "province": "浙江省", "city": "杭州市", "district": "西湖区",
  "lng": 120.14, "lat": 30.25, "category": "food", "tel": "",
  "checkin_count": 12, "rating_avg": 4.2, "rating_count": 10,
  "recommend_count": 8, "neutral_count": 2, "avoid_count": 1, "avg_cost": 135,
  "comment_count": 3, "cover_url": "/uploads/..",
  "created_at": "..."
}
```
统计只计入 **公开且正常** 旅程中 `status=visited` 的打卡点。

### PlaceReview（地点页中的打卡评价 = 某个公开旅程里的打卡点）
```json
{
  "waypoint": Waypoint, "photos": [Photo],
  "trip": { "id": 1, "title": "杭州三日" }, "author": UserBrief
}
```

### Comment
```json
{
  "id": 1, "trip_id": 1 | null, "place_id": null, "waypoint_id": 3 | null,
  "parent_id": null, "content": "排队一小时，不值", "deleted": false,
  "author": UserBrief, "reply_to": UserBrief | null,
  "can_delete": true, "created_at": "...",
  "replies": [Comment]
}
```
两级结构：顶层评论（`parent_id` 为 null）携带全部 `replies`（按时间正序）；回复的回复会挂在同一顶层评论下，并通过 `reply_to` 标明回复对象。被删除的评论 `content` 为空、`deleted=true`（若有回复则保留占位）。

### Footprints（足迹聚合）
```json
{
  "stats": {
    "trips": 5, "waypoints": 80, "photos": 300, "distance_km": 1234.5,
    "days": 20, "cities": 12, "provinces": 6,
    "first_date": "2024-01-01" | null, "last_date": "2026-05-03" | null
  },
  "points": [{ "lng": 120.1, "lat": 30.2, "name": "…", "city": "杭州市", "province": "浙江省",
               "category": "food", "verdict": "recommend", "trip_id": 1, "trip_title": "…", "date": "2026-05-01" }],
  "provinces": [{ "code": "330000", "name": "浙江省", "count": 20 }],
  "cities": [{ "code": "330100", "name": "杭州市", "province": "浙江省", "count": 15, "lng": 120.1, "lat": 30.2 }],
  "trips": [{ "id": 1, "title": "…", "start_date": "…", "end_date": "…", "cover_url": "…",
              "distance_km": 42.5, "path": [[120.1, 30.2], [120.2, 30.3]] }]
}
```
- `points` 最多 5000 个；`trips` 按 `start_date` 正序，`path` 为按顺序的打卡点坐标
- `cities[].lng/lat` 为该城市内打卡点的平均位置

### Notification
```json
{
  "id": 1, "type": "comment", "actor": UserBrief | null,
  "trip": { "id": 1, "title": "…" } | null, "place": { "id": 8, "name": "…" } | null,
  "comment_id": 5 | null, "content": "摘要", "read": false, "created_at": "..."
}
```
`type`: `comment` `reply` `like` `favorite` `fork` `follow` `trip_invite` `partner_invite` `partner_accept` `featured` `system`

---

## 接口

### 站点
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | 🔓 | `{"status":"ok","version":"..."}` |
| GET | `/site` | 🔓 | 站点配置（见下） |

`GET /site` 响应：
```json
{
  "name": "TripHub", "announcement": "", "registration_open": true,
  "amap_search": true, "ai_enabled": true,
  "map": {
    "tiles": {
      "normal": ["https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", "..."],
      "satellite": ["https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}", "..."],
      "satellite_label": ["https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}", "..."]
    }
  },
  "levels": [{ "level": 1, "name": "新手旅人", "min_exp": 0, "quota_mb": 300 }],
  "upload": { "max_photo_mb": 20 }
}
```
`amap_search`：服务端是否配置了高德 Web 服务 Key（未配置时地点搜索退化为城市级离线搜索）。
`ai_enabled`：服务端是否配置了 AI 模型（OpenAI 兼容接口）。

### 认证
| 方法 | 路径 | 权限 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/auth/register` | 🔓 | `{username, password, email?, nickname?}` | AuthResult |
| POST | `/auth/login` | 🔓 | `{account, password}`（account 为用户名或邮箱） | AuthResult |
| POST | `/auth/refresh` | 🔓 | `{refresh_token}` | AuthResult（旧 refresh token 作废） |
| POST | `/auth/logout` | 🔓 | `{refresh_token}` | `{}` |

AuthResult：
```json
{ "user": Me, "access_token": "…", "refresh_token": "…", "expires_in": 7200 }
```
规则：用户名 3–20 位字母数字下划线（不区分大小写唯一）；密码 6–64 位；邮箱可选、唯一。登录失败过多会返回 429。被封禁账号登录返回 403。

### 当前用户 🔐
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | Me |
| PATCH | `/me` | `{nickname?, bio?, avatar_url?, email?}` → Me |
| POST | `/me/password` | `{old_password, new_password}` → `{}`（其它 refresh token 全部失效） |
| POST | `/me/avatar` | multipart `file` → `{avatar_url}`（同时更新资料） |
| GET | `/me/trips` | `?phase=&visibility=&page=` 我创建或参与的旅程 → 分页 TripCard |
| GET | `/me/favorites` | 分页 TripCard |
| GET | `/me/footprints` | 我参与的全部旅程的 Footprints |
| GET | `/me/invites` | 待处理邀请 `{trip_invites:[{trip: TripCard, from: UserBrief, created_at}], partner_invites:[PartnerInvite]}` |

### 用户
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/users/:username` | 🔓 | UserProfile |
| GET | `/users/:username/trips` | 🔓 | 该用户公开旅程（本人则返回全部）→ 分页 TripCard |
| GET | `/users/:username/footprints` | 🔓 | 基于公开旅程的 Footprints（本人则全部） |
| POST | `/users/:username/follow` | 🔐 | 关注 → `{following: true, followers: n}` |
| DELETE | `/users/:username/follow` | 🔐 | 取消关注 |
| GET | `/users/:username/followers` | 🔓 | 分页 UserBrief |
| GET | `/users/:username/following` | 🔓 | 分页 UserBrief |

### 旅程
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/trips` | 🔓 | 广场列表，见下 |
| POST | `/trips` | 🔐 | 创建 → TripDetail |
| GET | `/trips/:id` | 🔓 | TripDetail（按可见性校验，非成员访问 view_count+1） |
| GET | `/share/:code` | 🔓 | 通过分享码访问（private 之外均可）→ TripDetail |
| PATCH | `/trips/:id` | 🔐 成员 | 修改 → TripDetail |
| DELETE | `/trips/:id` | 🔐 作者/管理员 | 删除（级联删除打卡点、照片、轨迹、评论） |
| POST | `/trips/:id/fork` | 🔐 | 一键引用路线：把对方的已到达/计划打卡点复制为自己的**计划路线**（新旅程 `phase=planning`，私密；打卡点 `planned=true,status=todo`，保留名称/地址/坐标/分类/天数/备注/人均，清空评价与时间）`{title?}` → TripDetail |
| POST / DELETE | `/trips/:id/like` | 🔐 | → `{liked, like_count}` |
| POST / DELETE | `/trips/:id/favorite` | 🔐 | → `{favorited, fav_count}` |
| POST | `/trips/:id/share-code/reset` | 🔐 作者 | → `{share_code}` |

`GET /trips` 查询参数：
- `tab`: `featured`（精选） | `latest`（默认，按发布时间） | `hot`（热门） | `following`（关注的人，需登录）
- `q`: 关键词（标题/简介/标签/城市）；`tag`；`province`；`city`；`phase`
- 只返回 `visibility=public` 且 `status=normal` 的旅程

创建 / 修改请求体（均可选，创建时 `title` 必填）：
```json
{
  "title": "杭州三日", "summary": "", "content": "", "cover_url": "",
  "phase": "planning", "visibility": "private",
  "start_date": "2026-05-01", "end_date": "2026-05-03", "tags": ["美食"],
  "with_partner": true
}
```
`with_partner`（仅创建时）：直接把已绑定的情侣加为共同作者。成员可以编辑内容；只有作者能修改 `visibility`、管理成员、删除旅程。

#### 共同作者
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/trips/:id/members` | 🔐 成员 | `[{user: UserBrief, role: "owner"|"editor", status: "accepted"|"pending"}]` |
| POST | `/trips/:id/members` | 🔐 作者 | 邀请 `{username}`（若为已绑定情侣则直接加入） |
| DELETE | `/trips/:id/members/:user_id` | 🔐 作者/本人 | 移除或退出 |
| POST | `/trips/:id/members/accept` | 🔐 被邀请人 | 接受邀请 |
| POST | `/trips/:id/members/decline` | 🔐 被邀请人 | 拒绝邀请 |

### 打卡点
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/waypoints` | 🔐 成员 | 创建 → Waypoint |
| POST | `/trips/:id/waypoints/batch` | 🔐 成员 | `{items: [同上]}` → `[Waypoint]` |
| PATCH | `/waypoints/:id` | 🔐 成员 | 修改 → Waypoint |
| DELETE | `/waypoints/:id` | 🔐 成员 | 删除（照片保留，`waypoint_id` 置空） |
| PUT | `/trips/:id/waypoints/order` | 🔐 成员 | `{ids: [..]}` 全量排序 → `[Waypoint]` |

创建 / 修改请求体：
```json
{
  "name": "楼外楼", "address": "孤山路30号", "lng": 120.14, "lat": 30.25, "coord_type": "gcj02",
  "day": 1, "category": "food", "planned": true, "status": "todo", "planned_at": "…", "arrived_at": "…",
  "note": "", "verdict": "recommend",
  "rating": 4, "cost": 150, "amap_id": "B023B0J1V1", "seq": 3
}
```
- `seq` 可选：插入到指定位置，缺省追加到末尾
- `planned` 缺省：旅程 `phase=planning` 时为 true，否则为 false；`status` 缺省：计划内为 `todo`，计划外为 `visited`（`arrived_at` 缺省为当前时间）
- 服务端根据坐标自动补全 `province` / `city` / `district`（配置了高德 Key 时补全区县与街道地址）；`name` 为空时用地址或区县名
- 若带 `amap_id`，或名称相同且 100 米内已有地点，则关联到同一个 Place；否则对用户填写了名称的打卡点新建 Place

### 按路线出行（旅行中）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/checkin` | 🔐 成员 | 「我到了」：见下 |
| POST | `/waypoints/:id/checkin` | 🔐 成员 | 标记计划点已到达 `{arrived_at?}` → Waypoint |
| POST | `/waypoints/:id/skip` | 🔐 成员 | 标记计划点跳过 → Waypoint |
| POST | `/waypoints/:id/reset` | 🔐 成员 | 恢复为 `todo`（仅计划内） → Waypoint |
| GET | `/trips/:id/recommend` | 🔐 成员 | 下一站推荐，见下 |
| GET | `/trips/:id/compare` | 🔓（按旅程可见性） | 计划 vs 实际对比，见下 |
| POST | `/ai/plan` | 🔐 | AI 规划路线，见下 |

开始旅行 / 结束旅行：`PATCH /trips/:id {"phase": "ongoing" | "finished"}`。

`POST /trips/:id/checkin` 请求：
```json
{ "lng": 120.1, "lat": 30.2, "coord_type": "wgs84",
  "name": "", "address": "", "amap_id": "", "category": "", "note": "", "waypoint_id": null }
```
- 指定 `waypoint_id`：标记该计划点已到达
- 否则：200 米内存在 `todo` 计划点 → 标记已到达（取 seq 最小的）；否则新建计划外打卡点（`planned=false,status=visited`），插入在最近一个已到达点之后；未给名称时用逆地理结果命名
- 旅程处于 `planning` 时自动变为 `ongoing`

响应：`{ "waypoint": Waypoint, "matched_plan": true }`

`GET /trips/:id/recommend?lng=&lat=&coord_type=wgs84&ai=true` 响应：
```json
{
  "next_planned": Waypoint | null, "next_planned_distance_m": 850,
  "suggestions": [{
    "name": "…", "address": "…", "lng": 120.1, "lat": 30.2, "category": "food",
    "distance_m": 420, "reason": "附近 8 人打卡，推荐率 90%，人均 ¥60",
    "source": "community", "place_id": 8, "amap_id": "B0…", "rating_avg": 4.5
  }],
  "warnings": [{ "place_id": 9, "name": "…", "distance_m": 300, "reason": "5 人踩雷：排队久、价格贵" }],
  "ai_text": "现在是傍晚，建议先去…" | null, "ai_used": true
}
```
- `source`: `plan`（计划中的后续点） | `community`（社区公开打卡的高分地点） | `amap`（高德周边搜索） | `ai`（AI 推荐）
- `ai=true` 且服务端配置了 AI 时，把位置、时间、已去/未去的点、候选地点交给大模型挑选并给出理由；失败时自动退回规则推荐
- `warnings`：附近被多人标记踩雷的地点

`GET /trips/:id/compare` 响应：
```json
{
  "planned": { "count": 10, "distance_km": 35.2, "path": [[120.1, 30.2]] },
  "actual": { "count": 9, "distance_km": 41.0, "track_distance_km": 43.5, "path": [[120.1, 30.2]] },
  "completion_rate": 0.8,
  "visited": [Waypoint], "skipped": [Waypoint], "todo": [Waypoint], "extra": [Waypoint],
  "days": [{ "day": 1, "planned": 4, "visited": 3, "extra": 1 }],
  "time_diffs": [{ "waypoint_id": 3, "name": "…", "planned_at": "…", "arrived_at": "…", "delta_minutes": 45 }]
}
```
`completion_rate` = 已到达的计划点 / 计划点总数；`extra` 为计划外打卡点。

`POST /ai/plan` 请求：
```json
{ "destination": "杭州", "days": 3, "preferences": "情侣、喜欢美食和拍照，不想太累", "start_date": "2026-10-01" }
```
响应：
```json
{ "title": "杭州三日·美食拍照之旅", "summary": "…",
  "items": [{ "day": 1, "name": "西湖断桥", "address": "…", "category": "scenic", "note": "建议清晨去，人少好拍",
              "lng": 120.15, "lat": 30.26, "located": true, "amap_id": "…", "place_id": null }] }
```
- 仅在 `ai_enabled` 时可用，否则返回 400 `未配置 AI 服务`
- 返回的是建议，不会自动保存。客户端可在用户确认后通过 `POST /trips` + `POST /trips/:id/waypoints/batch` 保存
- 地点坐标优先用高德搜索校正（`located=true`），无法定位的项 `located=false`，坐标可能为空

### 照片
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/photos` | 🔐 成员 | 上传，见下 |
| PATCH | `/photos/:id` | 🔐 成员 | `{caption?, waypoint_id?}`（waypoint_id 传 0 取消关联）→ Photo |
| DELETE | `/photos/:id` | 🔐 成员 | 删除 |
| POST | `/uploads/image` | 🔐 | 通用图片上传（封面等）multipart `file` → `{url, thumb_url, width, height}` |

`POST /trips/:id/photos`（multipart）字段：
- `file`（必填）：jpg / png / webp / gif
- `lng`, `lat`, `coord_type`（**默认 `wgs84`**，因为照片 EXIF 为 GPS 原始坐标）
- `taken_at`：RFC3339
- `caption`, `waypoint_id`
- `auto_waypoint`：`true` 时，若照片带位置且未指定 waypoint_id：300 米内已有打卡点则关联，否则自动新建打卡点（名称用区县/街道，`arrived_at` = 拍摄时间，按时间插入到合适位置）

客户端未提供位置/时间时，服务端尝试从 JPEG EXIF 读取。大于 2560px 的图片会被缩放，并生成 480px 缩略图。占用计入存储配额。

响应：
```json
{ "photo": Photo, "waypoint": Waypoint | null, "waypoint_created": false }
```

### 实时轨迹
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/track` | 🔐 成员 | 追加轨迹点，见下 |
| GET | `/trips/:id/track` | 🔓（按旅程可见性） | `?max=2000` 抽稀后的轨迹 |
| DELETE | `/trips/:id/track` | 🔐 成员 | 清空轨迹 |

追加请求（单次最多 1000 点）：
```json
{ "coord_type": "wgs84", "segment": 0,
  "points": [{ "lng": 120.1, "lat": 30.2, "alt": 12.5, "acc": 8, "speed": 1.2, "t": 1727000000000 }] }
```
响应 `{ "accepted": 10, "total_points": 520, "distance_km": 12.3 }`

获取响应：
```json
{ "segments": [[[120.1, 30.2, 12.5, 1727000000000]]], "point_count": 520,
  "distance_km": 12.3, "started_at": "…" | null, "ended_at": "…" | null }
```
`segments` 为多段轨迹，每点 `[lng, lat, alt, t_ms]`。有轨迹时旅程 `distance_km` 取轨迹里程，否则取打卡点连线里程。

### 评论
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/trips/:id/comments` | 🔓 | `?waypoint_id=` 可筛选某打卡点 → 分页顶层 Comment（含 replies） |
| POST | `/trips/:id/comments` | 🔐 | `{content, parent_id?, waypoint_id?}` → Comment |
| GET | `/places/:id/comments` | 🔓 | 分页顶层 Comment |
| POST | `/places/:id/comments` | 🔐 | `{content, parent_id?}` → Comment |
| DELETE | `/comments/:id` | 🔐 | 作者 / 旅程作者 / 管理员 |

评论内容 1–1000 字。

### 地点
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/places` | 🔓 | `?q=&city=&category=&sort=hot|rating|avoid&page=` → 分页 Place（仅有公开打卡的地点） |
| GET | `/places/nearby` | 🔓 | `?lng=&lat=&radius=2000&limit=30` → `[Place]`（按距离，带 `distance_m`） |
| GET | `/places/:id` | 🔓 | Place |
| GET | `/places/:id/reviews` | 🔓 | `?verdict=` 分页 PlaceReview（公开旅程中的打卡） |

### 地理
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/geo/search` | 🔓 | `?keyword=&city=&lng=&lat=` 地点搜索 |
| GET | `/geo/regeo` | 🔓 | `?lng=&lat=&coord_type=` 逆地理编码 |
| GET | `/geo/atlas` | 🔓 | 中国省/市边界 TopoJSON（对象 `provinces` / `prefectures` / `nation`，属性 `id`=区划码、`地名`） |

`/geo/search` 响应：
```json
{ "source": "amap", "items": [{ "amap_id": "B0…", "name": "楼外楼", "address": "孤山路30号",
  "province": "浙江省", "city": "杭州市", "district": "西湖区", "category": "food",
  "lng": 120.14, "lat": 30.25 }] }
```
`source` 为 `local` 时仅能搜索省/市名称（返回行政区中心）。

`/geo/regeo` 响应：
```json
{ "province": "浙江省", "province_code": "330000", "city": "杭州市", "city_code": "330100",
  "district": "西湖区", "street": "北山街道", "address": "浙江省杭州市西湖区孤山路30号",
  "lng": 120.14, "lat": 30.25 }
```

### 情侣空间「我们一起走过的地方」 🔐
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/partner` | `{partner: UserBrief|null, since: "2023-05-20"|null, title: "", bound_at, invites: {incoming: [PartnerInvite], outgoing: [PartnerInvite]}}` |
| PATCH | `/partner` | `{since?, title?}`（纪念日、空间名称，双方共享） |
| DELETE | `/partner` | 解除绑定 |
| POST | `/partner/invites` | `{username, message?}` → PartnerInvite |
| POST | `/partner/invites/:id/accept` | 接受 |
| POST | `/partner/invites/:id/decline` | 拒绝 |
| DELETE | `/partner/invites/:id` | 撤回自己发出的邀请 |
| GET | `/partner/trips` | 双方都是成员的旅程 → 分页 TripCard |
| GET | `/partner/footprints` | 双方共同旅程的 Footprints |

PartnerInvite：`{id, from: UserBrief, to: UserBrief, message, status: "pending", created_at}`。每人同时只能绑定一位。

### 通知 🔐
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/notifications` | `?unread_only=true&page=` 分页 Notification |
| GET | `/notifications/unread-count` | `{count}` |
| POST | `/notifications/read` | `{ids?: []}`，不传 ids 表示全部已读 |

### 举报 🔐
| POST | `/reports` | `{target_type: "trip"|"comment"|"user"|"place", target_id, reason}` → `{id}` |
|---|---|---|

### 管理后台 🛡
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/stats` | `{users, trips, public_trips, places, photos, comments, storage_bytes, today: {users, trips, comments}, trend: [{date, users, trips, comments}] (近14天)}` |
| GET | `/admin/users` | `?q=&role=&status=&page=` → 分页 AdminUser（Me 字段 + `trip_count`, `last_login_at`） |
| PATCH | `/admin/users/:id` | `{role?, status?, exp?}` → AdminUser |
| GET | `/admin/trips` | `?q=&status=&visibility=&page=` → 分页 TripCard |
| PATCH | `/admin/trips/:id` | `{featured?, status?}` → TripCard |
| DELETE | `/admin/trips/:id` | 删除 |
| GET | `/admin/comments` | `?q=&page=` → 分页 Comment（附 `trip: {id,title}`、`place: {id,name}`） |
| DELETE | `/admin/comments/:id` | 删除 |
| GET | `/admin/reports` | `?status=pending|resolved|rejected&page=` → 分页 `{id, reporter: UserBrief, target_type, target_id, target_preview, reason, status, note, created_at, handled_at}` |
| PATCH | `/admin/reports/:id` | `{status, note?}` |
| GET | `/admin/settings` | `{site_name, announcement, registration_open}` |
| PUT | `/admin/settings` | 同上 |

## 用户等级

经验值来源：创建旅程 +5、旅程首次公开 +20、添加打卡点 +1、上传照片 +1、发表评论 +1、旅程被点赞 +2、被收藏 +2、被评论 +1、被引用 +5、被关注 +2、被设为精选 +50（同一来源不重复计分）。

| 等级 | 名称 | 所需经验 | 存储空间 |
|---|---|---|---|
| Lv1 | 新手旅人 | 0 | 300 MB |
| Lv2 | 背包客 | 50 | 1 GB |
| Lv3 | 探路者 | 200 | 2 GB |
| Lv4 | 旅行家 | 600 | 5 GB |
| Lv5 | 环游者 | 1500 | 10 GB |
| Lv6 | 传奇旅人 | 4000 | 20 GB |

管理员无存储限制。游客可浏览公开内容；登录用户可创建、互动；管理员可管理用户与内容。
