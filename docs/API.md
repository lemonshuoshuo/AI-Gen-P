# TripHub API v1

网页端与后续 App 共用同一套 REST API。所有核心数据保存在服务端，客户端只负责展示与交互。

## 通用约定

- 基础路径：`/api/v1`
- 数据格式：JSON（上传文件用 `multipart/form-data`）
- 鉴权：`Authorization: Bearer <access_token>`。标注 🔓 的接口游客可访问，🔐 需要登录，🛡 需要管理员。
- 时间：RFC3339 字符串（如 `2026-09-24T10:00:00+08:00`）；日期：`YYYY-MM-DD`；轨迹点时间戳用 Unix 毫秒整数。
- 坐标：**所有响应中的坐标均为 GCJ-02（高德坐标系）**，`lng` 经度、`lat` 纬度。
  请求中带坐标的接口可传 `coord_type`：`gcj02`（默认）或 `wgs84`（GPS / 照片 EXIF 原始坐标），服务端会自动转换。
  境外坐标（中国周边粗略边界框之外，或框内 `server/internal/geo/transform.go` 的 `gcjExclude` 所列日韩、东南亚、南亚、蒙俄、中亚等区域）不做偏移，GCJ-02 即 WGS-84，与高德海外数据一致；客户端自行做 WGS-84 → GCJ-02 转换时须使用同一份区域表，或以 `coord_type=wgs84` 上传交由服务端转换。
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
`status`: `active` | `banned` | `deleted`（已注销，只会出现在管理后台的用户列表中）

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
`partner`：已绑定的情侣。仅当情侣关系设为公开（`PATCH /partner {"public": true}`），或查看者是该用户本人或其情侣时返回，否则为 `null`。

### TripCard（列表项）
```json
{
  "id": 1, "title": "杭州三日", "summary": "…（最多120字）", "cover_url": "/uploads/..", "cover_thumb_url": "/uploads/.._t.jpg",
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
- `status`: `normal` | `hidden`（被管理员隐藏，仅成员和管理员可见） | `pending`（开启「公开旅程需审核」后，非管理员公开的旅程等待管理员审核，通过前仅成员和管理员可见，见「内容安全」）
- `members`: 除作者外已接受邀请的共同作者
- `cover_thumb_url`：封面的 480px 缩略图，列表 / 卡片中使用；封面没有单独的缩略图（如使用头像地址）时与 `cover_url` 相同，没有封面时为空字符串。Place 与 Footprints 的 `trips[]` 中的同名字段含义相同
- `together`: 作者与其情侣都是该旅程成员时为 true

### TripDetail
TripCard +
```json
{
  "content": "正文（Markdown）",
  "share_code": "a8Kd92LmQx",
  "forked_from": { "id": 3, "title": "…", "author": UserBrief } | null,
  "liked": false, "favorited": false, "can_edit": true, "is_owner": true,
  "waypoints": [Waypoint], "photos": [Photo], "has_track": true, "live_share": false
}
```
`share_code` 仅成员可见。`live_share`：旅行中是否向非成员实时公开位置（见「旅行中的位置隐私」）。

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
- `place_id`: 关联的地点（见 Place），可为 null；在 TripDetail 中，当前查看者无权打开的地点返回 null（如通过分享码浏览「链接可见」旅程时）
- `place_stats`（仅 TripDetail 中）：关联地点有公开打卡时返回其社区统计 `{id, checkin_count, recommend_count, neutral_count, avoid_count, rating_avg}`（含义同 Place），否则不返回该字段

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
  "comment_count": 3, "cover_url": "/uploads/..", "cover_thumb_url": "/uploads/.._t.jpg",
  "created_at": "..."
}
```
统计只计入 **公开且正常** 旅程中 `status=visited` 的打卡点，且同一用户对同一地点只计一次：`checkin_count` 为打卡人数；推荐 / 一般 / 踩雷（`recommend_count` / `neutral_count` / `avoid_count`）、评分（`rating_avg` / `rating_count`）、人均（`avg_cost`）取该用户最近一次（按到达时间）有值的评价。

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
  "trips": [{ "id": 1, "title": "…", "start_date": "…", "end_date": "…", "cover_url": "…", "cover_thumb_url": "…",
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
  "comment_id": 5 | null, "content": "摘要", "read": false, "invite_pending": false, "created_at": "..."
}
```
`type`: `comment` `reply` `like` `favorite` `fork` `follow` `trip_invite` `partner_invite` `partner_accept` `featured` `system`
`invite_pending`：`trip_invite` 通知对应的共同作者邀请仍待接收者接受 / 拒绝时为 true（客户端据此显示「接受 / 拒绝」），邀请已处理或其它类型为 false

---

## 接口

### 站点
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | 🔓 | `{"status":"ok","version":"..."}` |
| GET | `/site` | 🔓 | 站点配置（见下） |
| GET | `/site/legal/:doc` | 🔓 | 用户协议 / 隐私政策（见下） |

`GET /site` 响应：
```json
{
  "name": "TripHub", "announcement": "", "registration_open": true,
  "icp_beian": "京ICP备12345678号-1", "police_beian": "",
  "amap_search": true, "ai_enabled": true,
  "map": {
    "attribution": "© 高德地图",
    "tiles": {
      "normal": ["https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", "..."],
      "satellite": ["https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}", "..."],
      "satellite_label": ["https://webst01.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}", "..."]
    }
  },
  "levels": [{ "level": 1, "name": "新手旅人", "min_exp": 0, "quota_mb": 300 }],
  "exp_daily_cap": 100,
  "upload": { "max_photo_mb": 20 }
}
```
`amap_search`：服务端是否配置了高德 Web 服务 Key（未配置时地点搜索退化为城市级离线搜索）。
`map.attribution`：底图版权 / 审图号（可含 HTML，由部署配置 `TRIPHUB_TILES_ATTRIBUTION` 决定，缺省 `© 高德地图`），客户端显示在地图角落。
`ai_enabled`：服务端是否配置了 AI 模型（OpenAI 兼容接口）。
`exp_daily_cap`：每人每天最多可获得的经验值（见「用户等级」）。
`icp_beian` / `police_beian`：管理员填写的 ICP 备案号、公安联网备案号（未填为空字符串），客户端应显示在页脚并分别链接到 `https://beian.miit.gov.cn/`、`https://beian.mps.gov.cn/`。

`GET /site/legal/:doc`（🔓，`doc` 为 `terms` 用户协议或 `privacy` 隐私政策，其他值返回 404）→ `{"content": "Markdown 文本"}`。管理员未填写时返回内置模板（`{{site}}` 已替换为站点名称）。

### 认证
| 方法 | 路径 | 权限 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/auth/register` | 🔓 | `{username, password, email?, nickname?, agree_terms}` | AuthResult |
| POST | `/auth/login` | 🔓 | `{account, password}`（account 为用户名或邮箱） | AuthResult |
| POST | `/auth/refresh` | 🔓 | `{refresh_token}` | AuthResult（旧 refresh token 作废；会话不变，此前签发的 access token 在过期前仍有效） |
| POST | `/auth/logout` | 🔓 | `{refresh_token}` | `{}`（该会话的 refresh token 与 access token 立即失效） |

AuthResult：
```json
{ "user": Me, "access_token": "…", "refresh_token": "…", "expires_in": 7200 }
```
规则：用户名 3–20 位字母数字下划线（不区分大小写唯一）；密码 8–64 位（示例密码或过于简单的密码会被拒绝）；邮箱可选、唯一。注册必须传 `agree_terms: true`（用户已阅读并同意《用户协议》和《隐私政策》），否则返回 400。登录失败过多会返回 429。被封禁账号登录返回 403。

### 当前用户 🔐
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | Me |
| PATCH | `/me` | `{nickname?, bio?, avatar_url?, email?}` → Me |
| DELETE | `/me` | 注销账号 `{password}` → `{}`，见下 |
| POST | `/me/password` | `{old_password, new_password}` → `{}`（其它会话的 refresh token 与 access token 全部立即失效） |
| POST | `/me/avatar` | multipart `file` → `{avatar_url}`（同时更新资料） |
| GET | `/me/trips` | `?phase=&visibility=&page=` 我创建或参与的旅程 → 分页 TripCard |
| GET | `/me/favorites` | 分页 TripCard |
| GET | `/me/footprints` | 我参与的全部旅程的 Footprints |
| GET | `/me/invites` | 待处理邀请 `{trip_invites:[{trip: TripCard, from: UserBrief, created_at}], partner_invites:[PartnerInvite]}` |

`DELETE /me`（注销账号，不可恢复）：密码错误返回 400 `密码不正确`；管理员账号不能注销（400）。注销后：
- 只有本人能编辑的旅程被删除（含照片、轨迹、评论）；有其他共同作者的旅程转交给最早加入的共同作者（其收到 `system` 通知）；
- 本人上传的照片和 GPS 轨迹全部删除；本人的评论变为已删除占位（`deleted=true`，作者显示为「已注销用户」）；
- 点赞、收藏、关注、共同作者身份、邀请、通知、经验记录和全部登录会话被删除；情侣绑定解除并通知对方；
- 账号信息被清除（用户名改为 `deleted-<id>`，原用户名可被重新注册），旧 token 返回 401，`/users/:username` 返回 404。

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
| POST | `/trips/:id/fork` | 🔐 | 一键引用路线：把对方的已到达/计划打卡点复制为自己的**计划路线**（新旅程 `phase=planning`，私密；打卡点 `planned=true,status=todo`，保留名称/地址/坐标/分类/天数/备注/人均，清空评价与时间）`{title?, include_avoid?}` → TripDetail。默认不复制原作者标记为踩雷（`verdict=avoid`）的打卡点；`include_avoid=true` 时一并复制，并在备注前加「⚠️ 原作者踩雷：」 |
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
  "live_share": false, "with_partner": true
}
```
`with_partner`（仅创建时）：直接把已绑定的情侣加为共同作者。成员可以编辑内容；只有作者能修改 `visibility`、`live_share`、管理成员、删除旅程。
`live_share`：旅行中（`phase=ongoing`）是否向非成员实时公开 GPS 轨迹、打卡和照片，缺省 `false`（见「旅行中的位置隐私」）。

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
- 带 `amap_id` 时，只关联到按高德 POI 数据（名称、地址、坐标、电话）建立的 Place：需要服务端配置了高德 Key、能查到该 POI，且打卡点距该 POI 不超过 5 公里；否则与未带 `amap_id` 的打卡点一样按名称匹配
- 名称相同且 100 米内已有公开地点（或自己参与的旅程中已用过的地点）时关联到同一个 Place；否则对用户填写了名称的打卡点新建 Place（不带 `amap_id`）。私密旅程里填写的名称、地址和坐标不会通过同名匹配或 AI 规划暴露给其他用户

### 按路线出行（旅行中）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/checkin` | 🔐 成员 | 「我到了」：见下 |
| POST | `/waypoints/:id/checkin` | 🔐 成员 | 标记计划点已到达 `{arrived_at?}` → Waypoint |
| POST | `/waypoints/:id/skip` | 🔐 成员 | 标记计划点跳过 → Waypoint |
| POST | `/waypoints/:id/reset` | 🔐 成员 | 恢复为 `todo`（仅计划内） → Waypoint |
| GET | `/trips/:id/recommend` | 🔐 成员 | 下一站推荐，见下 |
| GET | `/trips/:id/compare` | 🔓（按旅程可见性） | 计划 vs 实际对比，见下 |
| GET | `/trips/:id/legs` | 🔐（按旅程可见性） | 计划路线中同一天相邻打卡点之间的路程与耗时，`?mode=walking` / `transit` / `driving`（缺省 `transit`），见下 |
| POST | `/ai/plan` | 🔐 | AI 规划路线，见下 |

开始旅行 / 结束旅行：`PATCH /trips/:id {"phase": "ongoing" | "finished"}`。

`POST /trips/:id/checkin` 请求：
```json
{ "lng": 120.1, "lat": 30.2, "coord_type": "wgs84",
  "name": "", "address": "", "amap_id": "", "category": "", "note": "", "waypoint_id": null,
  "arrived_at": "…", "client_id": "…" }
```
- 指定 `waypoint_id`：标记该计划点已到达
- 否则：200 米内存在 `todo` 计划点 → 标记已到达（取距离最近的；与最近距离相差 20 米以内视为同一位置，取 seq 最小的）；否则新建计划外打卡点（`planned=false,status=visited`），插入在实际路线中最后一个已到达点之后（所有已到达点都有 `arrived_at` 时按到达时间排序，否则按 `seq`）；未给名称时用逆地理结果命名
- 旅程处于 `planning` 时自动变为 `ongoing`

响应：`{ "waypoint": Waypoint, "matched_plan": true, "duplicate": false }`
- 重复打卡：未指定 `waypoint_id` 时，若 50 米内有打卡点在 5 分钟内（以 `arrived_at` 或当前时间计）已到达，且没有更近的 `todo` 计划点（请求带 `amap_id` / `name` 时还须为同一地点），视为重复打卡（连点两次、请求重试、同行的人也点了「我到了」）：原样返回该点、不做修改，`duplicate=true`；指定 `waypoint_id` 且该点已到达时 `duplicate` 也为 true
- 客户端应只用 30 秒内、精度约 100 米以内的定位调用「我到了」；定位过旧或精度差时应先重新定位，或让用户在行程清单里选择到达的地点并传 `waypoint_id`
- `client_id`（可选，幂等键，≤64 个可见 ASCII 字符，如 UUID）：离线保存后补发的打卡应带上，并同时传点击时刻的 `arrived_at`。未指定 `waypoint_id` 时，同一旅程中已有用该 `client_id` 完成的打卡（新建或标记到达的点）则原样返回该点、`duplicate=true`，不会重复打卡（响应丢失后重发、多个标签页同时补发）

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
- `next_planned`：最后一个已到达的计划点之后的第一个 `todo` 计划点（中途漏打卡 / 跳过的点不计）；之后没有时取最早的 `todo` 计划点。`source=plan` 的建议按同样顺序，之前漏掉的计划点排在后面，理由为「计划中尚未去的站点」
- `ai=true` 且服务端配置了 AI 时，把位置、时间、已去/未去的点、候选地点交给大模型挑选并给出理由；失败时自动退回规则推荐
- `warnings`：附近（2 公里内）至少 2 人标记踩雷且踩雷多于推荐的地点；踩雷多于推荐的地点不会出现在 `suggestions` 中

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

`GET /trips/:id/legs?mode=transit` 响应：
```json
{
  "mode": "transit",
  "legs": [
    { "from_id": 11, "to_id": 12, "day": 1, "mode": "walking", "distance_m": 1180, "duration_s": 900, "straight_m": 946, "estimated": false },
    { "from_id": 12, "to_id": 14, "day": 1, "mode": "transit", "distance_m": 3900, "duration_s": 1680, "straight_m": 2700, "estimated": false }
  ],
  "days": [
    { "day": 1, "stops": 3, "distance_m": 5080, "duration_s": 2580, "estimated": false },
    { "day": 0, "stops": 1, "distance_m": 0, "duration_s": 0, "estimated": false }
  ]
}
```
- `legs`：计划路线（`planned=true` 的打卡点按 `seq` 排列）中**同一天**相邻两点之间的一段；不跨天（相邻两点 `day` 不同时没有路段），计划外打卡点不参与。`mode` 为该段实际采用的方式：`transit` 模式下直线距离 1 公里以内的路段、以及高德查不到公交地铁且直线不超过 30 公里的路段按步行，返回 `mode=walking`
- 服务端配置了高德 Key 时用高德路径规划计算（`estimated=false`）；未配置、调用失败或未能在约 4 秒内算完的路段按直线距离估算（`estimated=true`：路程取直线的 1.3 倍（驾车 1.4 倍）；步行 1.2 米/秒；公交地铁 6 米/秒另加 10 分钟；驾车 8 米/秒另加 3 分钟；直线 50 公里以上的公交地铁 / 驾车按 20 米/秒）。高德结果缓存 7 天，估算的路段会在之后的请求中逐步换成高德结果
- 公交地铁需要两端的城市（打卡点的 `city`，为空时按坐标离线判断），无法确定时按估算；直线超过 30 公里的步行、150 公里的公交地铁、1000 公里的驾车路段只估算
- `days`：每个有计划打卡点的天一项，按天排序，`day=0`（未分天）排在最后；`stops` 为当天的计划点数，`distance_m` / `duration_s` 为当天各路段之和（不含停留游玩时间），`estimated` 表示当天有估算的路段
- 需要登录（会消耗站点的高德配额）；可见性同 `GET /trips/:id`，同样支持 `share_code`

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
- `client_id`（可选，幂等键，≤64 个可见 ASCII 字符）：同一旅程中已有用该 `client_id` 上传的照片时不再保存，直接返回那张照片及其关联的打卡点（`duplicate=true`，`waypoint_created=false`），供离线补传安全重试

客户端未提供位置/时间时，服务端尝试从 JPEG EXIF 读取。大于 2560px 的图片会被缩放，并生成 480px 缩略图。占用计入存储配额。
单张图片最多约 5200 万像素，16 位或隔行 PNG 上限更低；超出返回 400「图片分辨率过大」。App 等客户端应先把长边压缩到 2560px 再上传。

响应：
```json
{ "photo": Photo, "waypoint": Waypoint | null, "waypoint_created": false, "duplicate": false }
```

### 实时轨迹
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/track` | 🔐 成员 | 追加轨迹点，见下 |
| GET | `/trips/:id/track` | 🔓（按旅程可见性） | `?max=2000` 抽稀后的轨迹 |
| DELETE | `/trips/:id/track` | 🔐 成员 | 清空轨迹 |
| POST | `/trips/:id/track/import` | 🔐 成员 | 导入 GPX 轨迹文件，见下 |

追加请求（单次最多 1000 点）：
```json
{ "coord_type": "wgs84", "segment": 0,
  "points": [{ "lng": 120.1, "lat": 30.2, "alt": 12.5, "acc": 8, "speed": 1.2, "t": 1727000000000 }] }
```
`segment`：非负整数（0 ~ 2^53−1，缺省 0），标识同一用户在该旅程中的一段连续记录；客户端每次开始记录时换一个新值（Web 端使用开始记录时的 Unix 秒时间戳）。同一段内按时间连线，不同段之间不连线、不计距离。

响应 `{ "accepted": 10, "total_points": 520, "distance_km": 12.3 }`（`accepted` 为新存入的点数，重复上传的点会被忽略）。每个旅程最多保存 1,000,000 个轨迹点，超出时返回 413 `payload_too_large`，客户端不应再重试这批点。

获取响应：
```json
{ "segments": [[[120.1, 30.2, 12.5, 1727000000000]]], "point_count": 520,
  "distance_km": 12.3, "started_at": "…" | null, "ended_at": "…" | null }
```
`segments` 为多段轨迹，每点 `[lng, lat, alt, t_ms]`；`point_count` 为已保存的轨迹点总数（不是返回的点数）。`max` 取值 10–20000，并向下取整到 10 / 50 / 100 / 200 / 500 / 1000 / 2000 / 5000 / 10000 / 20000 之一。旅程 `distance_km` 取 GPS 轨迹里程与已打卡点连线里程中的较大者（轨迹常只覆盖部分行程）；尚无已到达点时取轨迹里程，再无轨迹时取计划路线里程。多名成员都上传了轨迹时，按成员分别计算轨迹里程并取最长的一条（一起出行时不重复累计，`compare` 的 `track_distance_km` 同此规则）；`total_points` / `point_count` 为全部成员的点数。

`POST /trips/:id/track/import`（multipart）字段：
- `file`（必填）：GPX 1.0 / 1.1 文件（如两步路、六只脚、运动手表导出），读取其中的轨迹段 `trk > trkseg > trkpt`，忽略航点和路线；没有时间的点会被跳过；单个文件最多 50000 个点
- `coord_type`：**默认 `wgs84`**（GPX 为 GPS 原始坐标）
- 每个 `trkseg` 作为当前用户的一段轨迹，`segment` 取该段第一个点的 Unix 秒，因此重复导入同一文件不会产生重复点；导入不会把 `planning` 旅程切换为 `ongoing`
- 响应 `{ "accepted": 3000, "total_points": 3520, "distance_km": 42.1, "segments": 2 }`；文件无法解析、没有带时间的点或点数超限返回 400

浏览器只能在页面处于前台时定位（锁屏或切到导航 App 时暂停记录）。App 端应使用系统的后台定位持续记录，并以开始记录时的 Unix 秒作为 `segment` 分批调用 `POST /trips/:id/track`。

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
| GET | `/geo/search` | 🔐 | `?keyword=&city=&lng=&lat=` 地点搜索 |
| GET | `/geo/regeo` | 🔐 | `?lng=&lat=&coord_type=` 逆地理编码 |
| GET | `/geo/around` | 🔐 | `?lng=&lat=&coord_type=&radius=300&keyword=` 周边地点（打卡时选所在的店铺 / 景点），见下 |
| GET | `/geo/atlas` | 🔓 | 中国省/市边界 TopoJSON（对象 `provinces` / `prefectures` / `nation`，属性 `id`=区划码、`地名`） |

`/geo/search` 响应：
```json
{ "source": "amap", "items": [{ "amap_id": "B0…", "name": "楼外楼", "address": "孤山路30号",
  "province": "浙江省", "city": "杭州市", "district": "西湖区", "category": "food",
  "lng": 120.14, "lat": 30.25,
  "place": { "id": 12, "checkin_count": 8, "recommend_count": 2, "neutral_count": 1, "avoid_count": 5, "rating_avg": 2.4 } }] }
```
`place`：该高德 POI 对应地点的社区统计（同 Place 中的同名字段，便于规划时提示「踩雷」），该 POI 还没有公开打卡时为 `null`；`source=local` 时总为 `null`。
`source` 为 `local` 时仅能搜索省/市名称（返回行政区中心）：服务端未配置高德 Key，或高德暂时不可用（网络故障、Key 无效、当日调用额度用尽等；服务端会暂停调用一段时间后自动恢复）。
`/geo/search` 与 `/geo/regeo` 会消耗站点的高德调用额度，因此需要登录，且每人 10 分钟最多 120 次（两者合计），超出返回 429。

`/geo/around` 响应：`{ "source": "amap", "items": [...] }`，`items` 字段同 `/geo/search`（含 `place`），另加 `distance_m`（距请求坐标的米数），按距离由近到远，最多 20 个。`radius` 取值 50–5000（缺省 300 米），`keyword` 可选（≤50 字，如店名）。服务端未配置高德 Key 时返回 `{"source": "none", "items": []}`；高德暂时不可用时返回 `500 internal`（message 可直接展示）。与 `/geo/search`、`/geo/regeo` 共用每人 10 分钟 120 次的限额。

`/geo/regeo` 响应：
```json
{ "province": "浙江省", "province_code": "330000", "city": "杭州市", "city_code": "330100",
  "district": "西湖区", "street": "北山街道", "address": "浙江省杭州市西湖区孤山路30号",
  "lng": 120.14, "lat": 30.25 }
```

### 情侣空间「我们一起走过的地方」 🔐
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/partner` | `{partner: UserBrief|null, since: "2023-05-20"|null, title: "", bound_at, public: false, invites: {incoming: [PartnerInvite], outgoing: [PartnerInvite]}}` |
| PATCH | `/partner` | `{since?, title?, public?}`（纪念日、空间名称、是否在双方个人主页公开显示情侣关系（缺省不公开），双方共享） |
| DELETE | `/partner` | 解除绑定。`?remove_shared_access=true` 时同时结束共同作者关系：删除双方在对方创建的旅程中的成员身份（含待接受的邀请）；不传时共同旅程的成员关系保持不变，可在旅程「成员」中移除 |
| POST | `/partner/invites` | `{username, message?}` → PartnerInvite |
| POST | `/partner/invites/:id/accept` | 接受 |
| POST | `/partner/invites/:id/decline` | 拒绝 |
| DELETE | `/partner/invites/:id` | 撤回自己发出的邀请 |
| GET | `/partner/trips` | 双方都是成员的旅程 → 分页 TripCard |
| GET | `/partner/footprints` | 双方共同旅程的 Footprints |

PartnerInvite：`{id, from: UserBrief, to: UserBrief, message, status: "pending", created_at}`。每人同时只能绑定一位。同一邀请同时被接受与撤回 / 拒绝时只有先完成的操作生效，另一方返回 `404`（「邀请不存在或已处理」）。

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
| GET | `/admin/stats` | `{users, trips, public_trips, pending_trips, places, photos, comments, storage_bytes, today: {users, trips, comments}, trend: [{date, users, trips, comments}] (近14天)}`（`pending_trips`：待审核的公开旅程数） |
| GET | `/admin/users` | `?q=&role=&status=&page=` → 分页 AdminUser（Me 字段 + `trip_count`, `last_login_at`） |
| PATCH | `/admin/users/:id` | `{role?, status?, exp?}` → AdminUser |
| POST | `/admin/users/:id/reset-password` | `{password?}` → `{password}`（不传则生成 12 位随机密码；该用户全部会话的 refresh token 与 access token 立即失效；不能对自己或已注销账号操作） |
| GET | `/admin/trips` | `?q=&status=&visibility=&page=` → 分页 TripCard |
| PATCH | `/admin/trips/:id` | `{featured?, status?}`（`status` 为 `normal` / `hidden`；对 `pending` 旅程即审核通过 / 驳回，见「内容安全」）→ TripCard |
| DELETE | `/admin/trips/:id` | 删除 |
| GET | `/admin/comments` | `?q=&page=` → 分页 Comment（附 `trip: {id,title}`、`place: {id,name}`） |
| DELETE | `/admin/comments/:id` | 删除 |
| GET | `/admin/reports` | `?status=pending|resolved|rejected&page=` → 分页 `{id, reporter: UserBrief, target_type, target_id, target_preview, reason, status, note, created_at, handled_at}` |
| PATCH | `/admin/reports/:id` | `{status, note?}` |
| GET | `/admin/settings` | `{site_name, announcement, registration_open, icp_beian, police_beian, terms_md, privacy_md, sensitive_words, review_public_trips}` |
| PUT | `/admin/settings` | 同上（字段均可选）；`terms_md` / `privacy_md` 为 Markdown，留空表示使用内置模板；`sensitive_words` 屏蔽词（每行一个，也可用逗号分隔，≤100000 字，缺省为空）；`review_public_trips` 公开旅程需审核（缺省 false）。见「内容安全」 |

## 用户等级

经验值来源：创建旅程 +5、旅程首次公开 +20、添加打卡点 +1、上传照片 +1、发表评论 +1、旅程被点赞 +2、被收藏 +2、被评论 +1、被引用 +5、被关注 +2、被设为精选 +50（同一来源不重复计分）。每人每天（东八区自然日）最多获得 100 经验（`GET /site` 的 `exp_daily_cap`），超出的部分不计；「被设为精选」不受此限制。

| 等级 | 名称 | 所需经验 | 存储空间 |
|---|---|---|---|
| Lv1 | 新手旅人 | 0 | 300 MB |
| Lv2 | 背包客 | 50 | 1 GB |
| Lv3 | 探路者 | 200 | 2 GB |
| Lv4 | 旅行家 | 600 | 5 GB |
| Lv5 | 环游者 | 1500 | 10 GB |
| Lv6 | 传奇旅人 | 4000 | 20 GB |

管理员无存储限制。游客可浏览公开内容；登录用户可创建、互动；管理员可管理用户与内容。

---

## 服务端实现说明（补充约定）

以下为后端实现时对上文未尽之处的约定，均为**新增或澄清**，不改变已有字段。

### 通用
- 请求头携带了**无效/过期**的 access token 时，即使是 🔓 接口也返回 `401`（客户端应 refresh 后重试，refresh 失败则清除 token 以游客身份访问）。access token 属于某个登录会话（即签发它的 refresh token），该会话已登出或被吊销（修改密码、管理员重置密码）后同样返回 `401`。被封禁用户的 token 在 🔓 接口上按游客处理，在 🔐 接口上返回 `403 账号已被封禁`。
- 所有成功的删除 / 无返回体操作返回 `{}`；创建类接口统一返回 `200`。
- 时间字段统一输出为东八区 RFC3339（如 `2026-09-24T10:00:00+08:00`）；请求中也接受不带时区的 `YYYY-MM-DDTHH:mm[:ss]`（按东八区解释）。
- `coord_type` 缺省为 `gcj02`（包括 `/trips/:id/checkin`、`/trips/:id/recommend`、`/trips/:id/track` 等）；只有 `POST /trips/:id/photos` 缺省为 `wgs84`。
- 频率限制：同一 IP+账号 15 分钟内失败登录 5 次、同一 IP 失败 30 次后返回 429；同一 IP 每小时最多注册 10 个账号；每人 10 分钟最多 30 条评论；AI 接口每人每小时 30 次；地点搜索 / 逆地理 / 周边地点每人 10 分钟最多 120 次（超出返回 429）。并发请求同样受限（请求在校验密码前即计入，登录成功后退回）。
- 请求带 `Accept-Encoding: gzip` 时，JSON 响应与网页静态资源以 gzip 压缩返回。
- 常用长度限制：标题 ≤100、简介 ≤500、正文 ≤50000、标签 ≤10 个且每个 ≤20 字（自动去重、去掉 `#`）、昵称 ≤20、个人简介 ≤200、打卡点名称 ≤100 / 备注 ≤5000、批量打卡点 ≤200 个、共同作者 ≤20 人、照片说明 ≤500。

### 用户
- `Me.next_level_exp` 在满级时为 `null`；管理员的 `storage_quota` 为 `0`（表示不限）。
- `POST /me/password` 会吊销**除当前会话外**的全部会话，其 refresh token 与 access token 立即失效（当前会话由 access token 识别；也可额外传 `refresh_token` 指定保留）。
- `GET /users/:username/trips` 返回该用户作为作者或共同作者参与的旅程；`stats.likes` 为其公开旅程获赞总数。
- 忘记密码：由管理员在后台调用 `POST /admin/users/:id/reset-password` 重置。管理员自己忘记密码时在服务器上运行 `docker compose exec app /triphub reset-password -user <用户名>`（二进制部署：`TRIPHUB_DB_DSN=… ./triphub reset-password -user <用户名>`；`-password` 指定新密码，缺省随机生成；`-admin` 同时设为管理员）。配置 `TRIPHUB_ADMIN_PASSWORD` 不会修改已有账号的密码；`TRIPHUB_ADMIN_USERNAME` 指向已注册的普通用户时，只有密码与该用户当前密码一致才会授予管理员权限。

### 旅程
- **分享码访问子资源**：`unlisted` 旅程按 ID 访问时仅成员/管理员可见。通过分享链接浏览的访客，在请求 `GET /trips/:id`、`/trips/:id/track`、`/trips/:id/comments`、`/trips/:id/compare`、点赞 / 评论等旅程子接口时，可附带查询参数 `?share_code=xxx`（或请求头 `X-Share-Code`）获得与公开旅程相同的访问权限。
- `TripDetail.share_code` 仅成员可见，非成员时**不返回该字段**。`TripDetail` 额外返回 `invite_pending`（当前用户有待接受的共同作者邀请时为 true；被邀请人在接受前可预览旅程）。
- `TripCard.summary` 为空时由正文自动截取（最多 120 字）；`TripDetail.summary` 返回原始简介。`cover_url` 未设置时使用第一张照片。
- `cities` / `provinces` 按实际路线（`status=visited`）计算，尚无已到达点时退回计划路线；`distance_km` 取 GPS 轨迹里程与已打卡点连线里程中的较大者（规则见「实时轨迹」）。`days`：设置了起止日期时按日期，否则取打卡点最大 `day`，否则按到达时间跨度。
- `GET /me/favorites` 只列出当前仍可见（公开且正常，或本人为成员）的旅程。
- `POST /trips/:id/members` 返回更新后的成员列表（同 `GET /trips/:id/members`）；`POST /trips/:id/members/accept` 返回 `TripDetail`。成员列表管理员也可查看。
- 引用路线（fork）复制原旅程中除 `skipped` 和 `verdict=avoid`（踩雷；`include_avoid=true` 时保留）以外的全部打卡点，并复制标签与简介；自己引用自己的旅程不计 `fork_count`。`fork_count` 为当前持有该旅程引用副本的其他用户数：同一用户多次引用只计一次，引用副本被删除后相应减少。
- `GET /admin/trips` 额外支持 `?featured=true`。
- **旅行中的位置隐私**：旅程 `phase=ongoing` 且 `live_share=false`（默认）时，非成员（包括游客和持分享码的访客）看到的是「计划本身」：`TripDetail.waypoints` 只含计划内的打卡点，且均为 `status=todo`、`arrived_at=null`、`verdict=""`、`rating=0`；`photos` 为空，`has_track=false`，`visited_count` / `photo_count` 为 0；`GET /trips/:id/track` 返回空 `segments`（`point_count=0`）；`/compare` 同样只按计划返回（`visited` / `extra` 为空，`track_distance_km=0`）；`/places/:id/reviews`、`/users/:username/footprints` 不包含该旅程；引用路线（fork）只复制计划内的打卡点。成员和管理员不受影响；旅程结束（`finished`）后按原可见性全部公开。

### 打卡点 / 按路线出行
- 创建打卡点可额外传 `province` / `city` / `district`（如来自 `/geo/search` 结果）：`district` 优先使用客户端值；`province` / `city` 始终以离线行政区划为准，仅当坐标不在国内时才使用客户端值。
- 计划外且未给 `arrived_at` 的打卡点默认 `arrived_at` = 当前时间；例外：在 `phase=finished` 的旅程中补录时保持为空。
- 实际路线排序：全部已到达点都有 `arrived_at` 时按时间，否则按 `seq`。
- `PATCH /waypoints/:id` 将坐标移动超过 500 米时，若同一请求未提供 `amap_id` / `address`，则清除原 `amap_id`（按名称 + 新位置重新关联 Place），并清空地址后由逆地理编码重新补全（未配置高德 Key 时地址留空）。
- `POST /trips/:id/checkin` 可选传 `arrived_at`；新建的计划外点若设置了旅程开始日期则自动计算 `day`。`POST /waypoints/:id/checkin` 以及带 `waypoint_id` 的 `POST /trips/:id/checkin` 对已到达的点仅在显式传入 `arrived_at` 时更新时间（未传时保留原到达时间）。「我到了」打卡（`/trips/:id/checkin`、`/waypoints/:id/checkin`）与上传轨迹会把 `planning` 旅程自动切换为 `ongoing`。
- 自动建点的照片关联到 300 米内最近的打卡点；若该点是 `todo` 计划点、照片距它不超过 100 米，且旅程不处于 `planning`、照片带拍摄时间，则该计划点被标记为已到达（`arrived_at` = 拍摄时间）。
- `suggestions[]` 中 `source=plan` 的项额外带 `waypoint_id`（可直接调用 `/waypoints/:id/checkin`）。`ai` 参数缺省为 false。
- `POST /ai/plan`：`days` 1–15（缺省 3），`preferences` ≤300 字；AI 调用失败或超时返回 `500 internal`（message 可直接展示）。

### 照片 / 存储
- 除照片外，`POST /uploads/image` 的通用图片也计入存储配额（删除旅程/照片时释放对应照片占用）；头像不计入。
- 单张照片的占用 = 处理后原图 + 缩略图的字节数。

### 地点
- `GET /places/:id`：有公开打卡、带 `amap_id`、或被某个公开旅程引用的地点对所有人可见（reviews / comments 同样适用）；其余地点仅对引用了它的旅程成员（含待接受的邀请）和管理员可见（避免泄露私密旅程）。
- `TripDetail`（`GET /trips/:id`、`GET /share/:code`、创建 / 修改旅程的响应）中的打卡点在关联地点有公开打卡时带 `place_stats`（字段同 `/geo/search` 结果的 `place`），用于在行程中提示社区的「踩雷」评价；其它接口返回的 Waypoint 不带该字段。
- `GET /places` 的 `q` 同时匹配名称、地址、区县、城市、省份（与 `/trips` 的 `q` 一致）；`city` 参数仅按城市 / 省份筛选。
- `GET /places` 缺省 `sort=hot`；`rating` 只含有评分的地点，`avoid` 只含有踩雷记录的地点。`/places/nearby` 的 `radius` 取值 50–50000，`limit` ≤100，另支持 `category`。
- 地点统计中同一用户对同一地点只计一次（`checkin_count` 为打卡人数，评价、评分、人均取该用户最近一次有值的评价）；服务端升级后首次启动时按此规则重算全部地点（只执行一次）。旅行中的踩雷提醒（`/trips/:id/recommend` 的 `warnings`）和 AI 规划的「请避开」只针对至少 2 人标记踩雷且踩雷多于推荐的地点。

### 评论 / 通知
- 顶层评论按时间倒序、回复按时间正序。直接回复顶层评论时 `reply_to` 为 null；回复某条回复时挂到同一顶层评论下并设置 `reply_to`。已删除的回复不返回。
- 旅程评论（含回复）通知旅程作者（`comment`），回复另通知被回复者（`reply`，同一人只收一条）；地点评论只在被回复时通知。
- 通知中的 `trip` 仅在接收者当前仍可查看该旅程时返回。点赞 / 收藏 / 关注 / 引用通知对同一对象只发送一次。升级时会收到 `system` 通知。
- `POST /notifications/read` 返回 `{updated: n}`。

### 内容安全
- **屏蔽词**（`/admin/settings` 的 `sensitive_words`，缺省为空）：用户提交的旅程标题 / 简介 / 正文 / 标签、评论、打卡点名称 / 地址 / 备注、照片说明、昵称 / 个人简介、注册用户名、情侣空间名称与邀请留言中包含屏蔽词时返回 `400`，message 为 `内容包含不允许发布的词语「xx」，请修改后再提交`。匹配时忽略大小写、全角 / 半角、空格、标点与符号（如「博 彩」「博*彩」也会命中）。管理员不受限制。已发布的内容不会被追溯处理，但再次提交修改时会重新检查所提交的字段。
- **公开旅程需审核**（`review_public_trips`，缺省关闭）：开启后，非管理员新建公开旅程或把旅程改为公开时，旅程 `status` 为 `pending`：不出现在广场、搜索与地点统计中，非成员访问返回 404。管理员通过 `PATCH /admin/trips/:id {"status": "normal"}` 审核通过（`published_at` 更新为通过时间），`{"status": "hidden"}` 驳回；两种情况作者都会收到 `system` 通知。待审核的旅程改为非公开时退出审核队列（`status` 恢复为 `normal`）；被隐藏的旅程作者无法自行恢复。已公开的旅程修改内容不需重新审核；关闭审核不会自动通过队列中的旅程。「旅程首次公开」的经验在审核通过时发放。`GET /admin/trips?status=pending` 为审核队列。
- **图片地址**：`cover_url`、`avatar_url` 只接受本站上传得到的 `/uploads/...` 路径（或空字符串），外部链接返回 400；正文 Markdown 中的图片，客户端只显示 `/uploads/` 开头的地址。

### 管理后台
- `GET /admin/reports` 的 `target_preview`：用户为 `@username · 昵称：xxx`，旅程为标题，评论为内容摘要，地点为名称；对象已删除时为 `（已删除）`。
- 管理员不能取消自己的管理员权限或封禁自己；封禁会吊销该用户全部 refresh token。
