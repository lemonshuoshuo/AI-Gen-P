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
| conflict | 409 | 冲突（如重复；保存计划时的版本冲突见「协同编辑」） |
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
  "default_space_id": 3 | null,
  "created_at": "..."
}
```
`status`: `active` | `banned` | `deleted`（已注销，只会出现在管理后台的用户列表中）
`partner`：情侣，即自己所在情侣空间里的另一个人（见「空间」），没有时为 `null`。
`default_space_id`：默认空间（`PUT /me/default-space`），点击「我们」时打开它；没有设置时为 `null`。

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
`partner`：该用户的情侣（其情侣空间里的另一个人）。仅当情侣空间设为在主页公开（空间的 `public`：`PATCH /spaces/:id {"public": true}`，或旧接口 `PATCH /partner`），或查看者是该用户本人或其情侣时返回，否则为 `null`。

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
  "space": { "id": 3, "name": "我们", "type": "couple", "type_label": "情侣" } | null,
  "author": UserBrief, "members": [UserBrief],
  "created_at": "...", "updated_at": "...", "published_at": "..." | null,
  "revision": 12
}
```
- `phase`: `planning`（规划中，可作为路线攻略分享） | `ongoing`（旅行中） | `finished`（已完成，游记）
- `planned_count`：计划内打卡点数；`visited_count`：已到达的打卡点数（含计划外）。旅行中且未开启 `live_share` 的旅程，非成员看到的统计只按计划计算（见「旅行中的位置隐私」）
- `waypoint_count` / `planned_count` / `visited_count` 只计游玩点（`kind=stop`），不计住宿（`kind=lodging`，见 Waypoint）
- `days`：旅程天数，客户端按它显示「第 1 天 … 第 N 天」的页签（另有「不分天」）。设置了起止日期时按日期；否则为设置的天数（创建 / 修改旅程时的 `days`）与打卡点最大 `day`（住宿按其 `day`）中较大者；都没有时按到达时间跨度，再没有为 0
- `visibility`: `private`（仅成员） | `unlisted`（持分享链接可看，不出现在广场） | `public`（公开）。旅程的**成员**指作者、已接受邀请的共同作者，以及旅程所属空间的成员（见「空间」）；本文档中「成员」可见 / 可用的内容与接口（🔐 成员）对这三种人都一样
- `status`: `normal` | `hidden`（被管理员隐藏，仅成员和管理员可见） | `pending`（开启「公开旅程需审核」后，非管理员公开的旅程等待管理员审核，通过前仅成员和管理员可见，见「内容安全」）
- `members`: 除作者外已接受邀请的共同作者（不含只因旅程所属空间而有权限的空间成员）
- `cover_thumb_url`：封面的 480px 缩略图，列表 / 卡片中使用；封面没有单独的缩略图（如使用头像地址）时与 `cover_url` 相同，没有封面时为空字符串。Place 与 Footprints 的 `trips[]` 中的同名字段含义相同
- `together`: 旅程关联到**有两个人**的情侣空间（空间里只有一个人——还在等对方加入或对方已离开——时不算），或作者的情侣（作者情侣空间里的另一个人）是该旅程的共同作者时为 true。前一种情况对不在这个空间里的人（含游客）只在情侣关系公开（空间的 `public`）时为 true，不会借此透露私下的情侣关系
- `space`：旅程所属的空间（SpaceRef，见 Space），只返回给该空间的成员；其他人（游客、非空间成员的共同作者等）为 `null`
- `revision`：旅程的版本号（≥ 1），旅程及其打卡点、住宿、打卡、照片、成员每有一次修改加 1，`updated_at` 同时更新为修改时间（见「协同编辑」）。旅行中且未开启 `live_share` 的旅程，非成员看到的 `revision` 为 0、`updated_at` 同 `created_at`（修改记录会暴露旅行者的行踪）

### TripDetail
TripCard +
```json
{
  "content": "正文（Markdown）",
  "share_code": "a8Kd92LmQx",
  "forked_from": { "id": 3, "title": "…", "author": UserBrief } | null,
  "liked": false, "favorited": false, "can_edit": true, "is_owner": true,
  "waypoints": [Waypoint], "photos": [Photo], "has_track": true, "live_share": false,
  "travel_mode": "auto"
}
```
`share_code` 仅成员可见。`live_share`：旅行中是否向非成员实时公开位置（见「旅行中的位置隐私」）。
`travel_mode`：旅程偏好的出行方式 `auto`（缺省：每段按距离推荐步行 / 骑行 / 驾车）| `walking` | `riding` | `driving` | `transit`，是 `GET /trips/:id/legs` 的缺省 `mode`，行程页与 3D 回放据此显示路线。
`members`（TripCard 字段）为作者之外全部已接受邀请的共同作者（不限人数、不只是情侣），每项都是带 `avatar_url` 的 UserBrief；作者见 `author`。

### Waypoint（打卡点）
```json
{
  "id": 1, "trip_id": 1, "seq": 0, "day": 1, "kind": "stop",
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
- `seq`: 旅程内顺序（从 0 开始，计划内与计划外打卡点共用一个序列）；`day`: 第几天（0 表示未指定：「不分天」，即「想去」的地点池）
- `kind`: `stop`（游玩点，缺省，旧数据均为 `stop`） | `lodging`（住宿）。**住宿**的 `day=N` 表示第 N 天晚上住的地方：第 N 天在这里结束、第 N+1 天从这里出发；`day=0` 表示出发前一晚（第 1 天从这里出发），**不是**「不分天」。每个旅程每晚最多一个住宿；连住几晚就是每晚一条（见 `POST /trips/:id/lodging`）。住宿总是计划内（`planned=true`），缺省分类 `hotel`；它不是打卡点：不计入旅程的打卡点数、完成率，也不在 `compare` 的计划点列表里（见各接口说明）。住宿的 `seq` 只影响列表顺序，路线（`legs`、下一站推荐等）中住宿总是在当天的游玩点之后
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
统计只计入 **公开且正常** 旅程中 `status=visited` 的打卡点，且同一用户对同一地点只计一次：`checkin_count` 为打卡人数；推荐 / 一般 / 踩雷（`recommend_count` / `neutral_count` / `avoid_count`）、评分（`rating_avg` / `rating_count`）、人均（`avg_cost`）取该用户最近一次（按到达时间）有值的评价。旅行中（`phase=ongoing`）且未开启 `live_share` 的旅程，在结束或开启实时公开后才计入（地点封面 `cover_url` 同理），见「旅行中的位置隐私」。

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
  "points": [{ "waypoint_id": 12, "photo_thumb_url": "/uploads/2026/05/xxx_t.jpg",
               "lng": 120.1, "lat": 30.2, "name": "…", "city": "杭州市", "province": "浙江省",
               "category": "food", "verdict": "recommend", "trip_id": 1, "trip_title": "…", "date": "2026-05-01" }],
  "provinces": [{ "code": "330000", "name": "浙江省", "count": 20 }],
  "cities": [{ "code": "330100", "name": "杭州市", "province": "浙江省", "count": 15, "lng": 120.1, "lat": 30.2 }],
  "trips": [{ "id": 1, "title": "…", "start_date": "…", "end_date": "…", "cover_url": "…", "cover_thumb_url": "…",
              "distance_km": 42.5, "path": [[120.1, 30.2], [120.2, 30.3]] }]
}
```
- `points` 最多 5000 个；`trips` 按 `start_date` 正序，`path` 为按顺序的打卡点坐标
- `points[].waypoint_id`：对应的打卡点；`photo_thumb_url`：该打卡点第一张照片（与旅程页相同的顺序：按拍摄时间，再按上传顺序）的缩略图，没有照片时为空字符串。用于地图放大后在足迹点上显示照片。足迹只包含查看者能在旅程页看到照片的旅程（本人参与的、所在空间的，或公开且未处于「旅行中未公开位置」的旅程，见「旅行中的位置隐私」），因此不会露出旅程页上看不到的照片
- `cities[].lng/lat` 为该城市内打卡点的平均位置

### Notification
```json
{
  "id": 1, "type": "comment", "actor": UserBrief | null,
  "trip": { "id": 1, "title": "…" } | null, "place": { "id": 8, "name": "…" } | null,
  "space": { "id": 3, "name": "我们", "type": "couple", "type_label": "情侣" } | null,
  "comment_id": 5 | null, "content": "摘要", "read": false, "invite_pending": false, "space_invite_id": 7 | null,
  "created_at": "..."
}
```
`type`: `comment` `reply` `like` `favorite` `fork` `follow` `trip_invite` `space_invite` `space_accept` `space_decline` `featured` `system`，以及旧版本产生的 `partner_invite` `partner_accept`（升级后不再产生，只会出现在旧通知里）
`invite_pending`：`trip_invite` 通知对应的共同作者邀请、或 `space_invite` 通知对应的空间邀请仍待接收者接受 / 拒绝时为 true（客户端据此显示「接受 / 拒绝」），邀请已处理或其它类型为 false
`space`：空间相关通知（`space_invite` / `space_accept` / `space_decline`，以及退出、移除、删除空间等 `system` 通知）的空间，仅当接收者现在是该空间的成员或有待回应的邀请时返回，否则为 `null`（`content` 中有空间名称）
`space_invite_id`：`space_invite` 通知的邀请仍待回应时为该邀请的 ID（`POST /space-invites/:id/accept` / `decline`），否则为 `null`
`space_invite` 的 `content` 为邀请留言（发送者自己写的话），没有留言时为空字符串；`space_accept` / `space_decline` 的 `content` 为跟在发起人昵称后的一句话（如「接受了邀请，加入了「我们」」「拒绝了加入「驴友团」的邀请」）；`system` 通知的 `content` 为完整的一句话。旧的 `partner_invite` 的 `content` 为邀请留言

### Space（空间）
一组一起旅行的人：情侣、闺蜜、朋友、家人，或自定义的类型（如「驴友团」）。关联到空间的旅程对空间的全部成员开放，权限与共同作者相同（见「空间」）。

SpaceRef（空间的引用，TripCard、Notification 中使用）：
```json
{ "id": 3, "name": "我们", "type": "couple", "type_label": "情侣" }
```
- `type`: `couple`（情侣，最多 2 人） | `besties`（闺蜜） | `friends`（朋友） | `family`（家人） | `custom`（自定义）
- `type_label`：类型的显示名称，内置类型为 `情侣` / `闺蜜` / `朋友` / `家人`，`custom` 为创建者填写的名称（如 `驴友团`）；客户端直接显示它即可

Space（`GET /spaces` 的列表项，只有空间成员能看到）= SpaceRef +
```json
{
  "description": "大学室友", "anniversary": "2023-05-20" | null, "public": false,
  "owner": UserBrief, "role": "owner", "is_default": true,
  "members": [SpaceMember], "member_count": 2,
  "trip_count": 5, "city_count": 12, "last_trip": TripBrief | null,
  "pending_invite_count": 0,
  "can_manage": true, "can_invite": false,
  "created_at": "...", "updated_at": "..."
}
```
- `role`：当前用户在空间中的角色：`owner`（创建者） | `member`；创建者本人见 `owner`（UserBrief）
- `anniversary`：纪念日（可选，主要用于情侣空间），没有时为 `null`
- `public`：只对情侣空间有意义：是否在两人的个人主页上显示情侣关系（UserProfile 的 `partner`）；其他类型总为 `false`
- `is_default`：是否是当前用户的默认空间（`PUT /me/default-space`）
- `members`：全部成员，创建者在前，其余按加入的先后；`member_count` 为成员数
- `trip_count`：关联到空间的旅程数（含规划中的）；`city_count`：这些旅程中已到达的打卡点覆盖的城市数（同 Footprints 的 `stats.cities`）
- `last_trip`：最近的一次旅程，即 `GET /spaces/:id/trips` 的第一项；没有旅程时为 `null`
- `pending_invite_count`：待对方回应的邀请数
- `can_manage`：当前用户能否修改空间设置（创建者；情侣空间的两个人都能）
- `can_invite`：当前用户现在能否邀请：有邀请的权限（情侣空间为创建者，其他空间为任何成员），且成员数加待回应的邀请数还没到上限

SpaceMember = UserBrief + `{ "space_role": "owner" | "member", "joined_at": "..." }`（其中 UserBrief 的 `role` 仍是 `user` / `admin`）

TripBrief：
```json
{ "id": 1, "title": "杭州三日", "cover_url": "/uploads/..", "cover_thumb_url": "/uploads/.._t.jpg", "phase": "finished",
  "start_date": "2026-05-01" | null, "end_date": "2026-05-03" | null, "days": 3, "cities": ["杭州市"] }
```

SpaceDetail（`GET /spaces/:id`，以及创建、修改空间与接受邀请的响应）= Space +
```json
{
  "stats": { "trip_count": 5, "trips": 4, "waypoints": 80, "photos": 300, "distance_km": 1234.5,
             "days": 20, "cities": 12, "provinces": 6, "first_date": "2024-01-01" | null, "last_date": "2026-05-03" | null },
  "invites": [SpaceInvite]
}
```
- `stats.trip_count` 同 `trip_count`；其余字段与空间足迹（`GET /spaces/:id/footprints`）的 `stats` 完全相同：`trips` 为已有到达记录或轨迹的旅程数，`distance_km` 为它们的里程之和，`days` 为它们覆盖的日期数，`first_date` / `last_date` 为最早 / 最晚的旅行日期（如「第一次一起旅行」）
- `invites`：待回应的邀请（空间成员都能看到），按发出的先后

SpaceInvite：
```json
{
  "id": 7,
  "space": { "id": 3, "name": "周末爬山", "type": "custom", "type_label": "驴友团", "description": "",
             "member_count": 4, "members": [UserBrief] },
  "inviter": UserBrief, "invitee": UserBrief,
  "message": "一起去爬山吧", "status": "pending", "created_at": "..."
}
```
`status`: `pending` | `accepted` | `declined` | `cancelled`（撤回）。`space.members` 为空间现在的成员（创建者在前），让被邀请人在接受前知道里面有谁。

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
  "amap_search": true, "place_search": true, "ai_enabled": true,
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
`amap_search`：服务端是否配置了高德 Web 服务 Key（未配置时地点搜索退化为天地图或城市级离线搜索）。
`place_search`：能否搜索具体地点（配置了高德或天地图 Key 之一）；为 false 时 `/geo/search` 只能找到省 / 市。
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
| GET | `/me/trips` | `?phase=&visibility=&include_spaces=&page=` 我创建或参与的旅程（作者或共同作者）；`include_spaces=true` 时还包括我所在空间里的其他旅程 → 分页 TripCard |
| GET | `/me/favorites` | 分页 TripCard |
| GET | `/me/footprints` | 我参与的全部旅程（作者或共同作者，不含只因空间可见的旅程；空间的足迹见 `GET /spaces/:id/footprints`）的 Footprints |
| GET | `/me/invites` | 待处理邀请 `{trip_invites:[{trip: TripCard, from: UserBrief, created_at}], space_invites:[SpaceInvite], partner_invites:[PartnerInvite]}`（`partner_invites` 已弃用：`space_invites` 中情侣空间的那些，格式见旧接口「情侣空间」） |
| PUT | `/me/default-space` | `{space_id}` 设置默认空间（`null` 或 `0` 清除）→ Me，见「空间」 |

`POST /me/password` 与 `DELETE /me` 校验密码：同一账号 15 分钟内密码错误 5 次后返回 429（两个接口合计，密码正确的请求不计入），防止拿到登录令牌的人猜出密码。

`DELETE /me`（注销账号，不可恢复）：密码错误返回 400 `密码不正确`；管理员账号不能注销（400）。注销后：
- 只有本人能编辑的旅程被删除（含照片、轨迹、评论）；有其他共同作者的旅程转交给最早加入的共同作者（其收到 `system` 通知）。空间里的旅程离开空间时，在其中打过卡、传过照片或轨迹的空间成员成为共同作者（见「空间里的旅程」），因此这样的旅程转交给他们中最早留下内容的人，不会连同他们的照片和打卡一起被删除；
- 本人上传的照片和 GPS 轨迹全部删除；本人的评论变为已删除占位（`deleted=true`，作者显示为「已注销用户」）；
- 点赞、收藏、关注、共同作者身份、邀请（含空间邀请）、通知、经验记录和全部登录会话被删除；
- 退出所在的全部空间：自己的旅程先离开这些空间（因此只在空间中共享、既没有其他共同作者也没有其他成员在其中留下内容的旅程同样被删除）；是创建者的空间交给最早加入的成员（其收到 `system` 通知），只有自己一人的空间被删除；情侣空间的另一方收到「对方已注销账号，情侣绑定已解除」；
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
| POST | `/trips/:id/fork` | 🔐 | 一键引用路线：把对方的已到达/计划打卡点复制为自己的**计划路线**（新旅程 `phase=planning`，私密；打卡点 `planned=true,status=todo`，保留名称/地址/坐标/分类/天数/`kind`（住宿也一并复制）/备注/人均，清空评价与时间；新旅程的天数（`days`）与 `travel_mode` 同原旅程，不复制日期）`{title?, include_avoid?}` → TripDetail。默认不复制原作者标记为踩雷（`verdict=avoid`）的打卡点（包括住宿）；`include_avoid=true` 时一并复制，并在备注前加「⚠️ 原作者踩雷：」 |
| POST / DELETE | `/trips/:id/like` | 🔐 | → `{liked, like_count}` |
| POST / DELETE | `/trips/:id/favorite` | 🔐 | → `{favorited, fav_count}` |
| POST | `/trips/:id/share-code/reset` | 🔐 作者 | → `{share_code}` |
| GET | `/trips/:id/revision` | 🔓（按旅程可见性） | 当前版本号、最后修改人、正在编辑的成员（轮询用），见「协同编辑」 |
| POST | `/trips/:id/editing` | 🔐 成员 | 编辑页的心跳 `{active}`，见「协同编辑」 |
| PUT | `/trips/:id/plan` | 🔐 成员 | 一次性保存编辑页的整份计划（草稿），检测他人的修改，见「协同编辑」 |

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
  "live_share": false, "with_partner": true, "space_id": 3,
  "days": 3, "travel_mode": "auto"
}
```
`with_partner`（仅创建时）：直接把情侣（自己情侣空间里的另一个人）加为共同作者，没有给出 `space_id` 时同时把旅程关联到情侣空间；没有情侣时忽略。成员可以编辑内容；只有作者能修改 `visibility`、`live_share`、管理成员、删除旅程。
`space_id`：旅程所属的空间（见「空间」），该空间的全部成员都能查看和编辑这个旅程；`null` 或 `0` 表示不属于任何空间。创建时：自己必须是该空间的成员，否则 404 `空间不存在或你不是它的成员`。修改时：
- 加入空间或改到另一个空间：只有作者可以（否则 403），且作者必须是目标空间的成员（否则 404）；
- 移出空间（`null`）：作者或该空间的创建者可以（否则 403）。空间创建者移出别人的旅程后自己就看不到它了，此时响应为 `{}`（其他情况都响应 TripDetail）；
- 算作一次修改（`revision` +1）；同时有别人改了所属空间时返回 409 `旅程所属的空间刚被修改，请刷新后重试`；
- `PUT /trips/:id/plan` 的 `trip` 中的 `space_id` 被忽略。
`days`（0–365，`0` 或 `null` 表示不再指定）：规划的天数，没有日期的旅程也可以按天规划。有开始日期时同时把结束日期设为「开始日期 + days − 1」（同一请求里给出的结束日期与之不符时返回 400 `天数与起止日期不一致`）；只改起止日期时天数随日期变化（清除日期后保留该天数）。天数（或日期范围）变少时：被去掉的那些天的游玩点移到「不分天」（`day=0`）；被去掉的那些晚（`day` 大于新天数；最后一天当晚保留）的住宿，若同一家（同一高德 POI / 地点，或同名且相距 100 米内）在保留的某晚仍然住，则删除（照片、评论保留并取消关联），否则改为「不分天」的游玩点（`kind=stop, day=0`），不会丢失用户填写的内容。
`travel_mode`：见 TripDetail，缺省 `auto`；取值错误返回 400。
`live_share`：旅行中（`phase=ongoing`）是否向非成员实时公开 GPS 轨迹、打卡和照片，缺省 `false`（见「旅行中的位置隐私」）。

收藏（`POST /trips/:id/favorite`）仅限公开且正常的旅程或自己参与的旅程（与 `GET /me/favorites` 的列出规则一致），否则返回 403（如持分享码浏览的「链接可见」旅程）；取消收藏不受限制。

#### 共同作者
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/trips/:id/members` | 🔐 成员 | `[{user: UserBrief, role: "owner"|"editor", status: "accepted"|"pending"}]` |
| POST | `/trips/:id/members` | 🔐 作者 | 邀请 `{username}`（对方是作者的情侣时直接加入；不属于任何空间的旅程同时加入两人的情侣空间。其他人——包括旅程所属空间的成员——需对方接受，因为接受后旅程会出现在对方的「我的旅程」、个人主页和足迹里） |
| DELETE | `/trips/:id/members/:user_id` | 🔐 作者/本人 | 移除或退出 |
| POST | `/trips/:id/members/accept` | 🔐 被邀请人 | 接受邀请 |
| POST | `/trips/:id/members/decline` | 🔐 被邀请人 | 拒绝邀请 |

#### 协同编辑
几位成员同时编辑一个旅程时，用旅程的版本号 `revision` 保持同步：编辑页轮询 `GET /trips/:id/revision`，版本号变了就重新获取旅程；用户在本地改好整份计划（草稿）后点「保存」，用 `PUT /trips/:id/plan` 一次提交，服务端只在草稿所基于的版本仍是最新时保存，否则返回 409，由用户选择重新加载或覆盖。

**版本号**：`revision`（TripCard / TripDetail 中也有）从 1 开始，下列修改与「版本号 +1」在同一个事务中提交（一个请求 +1，只有 `PATCH /waypoints/:id` 既改了内容又改了顺序时 +2——带 `seq`，或住宿改到另一晚后移到那天之后；没有实际改动的请求不变）：
- 旅程本身：`PATCH /trips/:id`、`PUT /trips/:id/plan`、重置分享码，管理员设为精选 / 隐藏 / 审核；
- 打卡点与住宿：新建、批量新建、`POST /trips/:id/lodging`、修改、排序、删除，一键规划路线（`apply=true` 且有变化时）；
- 打卡：`/trips/:id/checkin`、`/waypoints/:id/checkin`、`skip`、`reset`（重复打卡、状态没变时除外）；
- 照片：上传、修改（说明 / 关联的打卡点）、删除；
- 轨迹：清空、导入 GPX，以及让旅程第一次有轨迹或因此开始旅程（`planning` → `ongoing`）的那次上传；之后持续上传的 GPS 点不改变版本号；
- 成员：邀请、接受 / 拒绝邀请、移除 / 退出，解除情侣绑定（或退出、移出、删除情侣空间）时 `remove_shared_access=true` 结束的共同作者关系，旅程离开空间时空间成员成为共同作者，注销账号带来的变化；
- 空间：旅程加入 / 移出空间（`PATCH /trips/:id` 的 `space_id`），以及作者退出或被移出空间、空间被删除时旅程随之离开空间（空间成员的加入与退出本身不改变旅程的版本号）。

点赞、收藏、评论、浏览不改变版本号。每次修改同时更新旅程的 `updated_at`，并记下修改人（`updated_by`）。

`GET /trips/:id/revision`（🔓，权限同 `GET /trips/:id`，可带 `share_code`）响应：
```json
{
  "revision": 42, "updated_at": "2026-09-29T10:00:00+08:00",
  "updated_by": UserBrief | null,
  "editors": [{ "user": UserBrief, "since": "2026-09-29T09:58:00+08:00", "last_seen": "2026-09-29T10:00:05+08:00" }]
}
```
- `updated_at`：最后一次修改的时间；`updated_by`：最后修改的人（升级前的旧数据等未知时为 `null`）
- `editors`：正在编辑该旅程的成员（45 秒内发过心跳，见下），按开始编辑的先后排列，包括请求者自己：客户端显示「谁正在编辑」时按 `user.id` 去掉自己
- `updated_by` 与 `editors` 只返回给成员（含待接受邀请的人）和管理员，其他人为 `null` 与 `[]`；旅行中且未开启 `live_share` 时，非成员得到 `revision=0`、`updated_at` 为旅程的创建时间（同 TripCard）
- 很轻量（除登录校验外一次查询，成功的请求不记日志），供轮询：编辑页建议每 5 秒、行程页每 15–30 秒一次，页面不可见时暂停。`revision` 大于本地已加载的版本时重新获取 `GET /trips/:id`；`updated_by.id` 是自己时，通常是自己刚做的修改（或自己在其他页面的修改），不必提示

`POST /trips/:id/editing`（🔐 成员；待接受邀请的人返回 403；非成员看不到这段旅程时返回 404 `旅程不存在或无权查看`，能看到（公开旅程、带分享码的「链接可见」旅程）时返回 403）请求 `{"active": true}`：进入编辑页时发送一次，之后每 15–20 秒一次心跳（`active` 缺省为 true）；离开编辑页时发送 `{"active": false}`（页面关闭时可用 `fetch(…, {keepalive: true})`），没有发送时 45 秒后自动过期。响应同 `GET /trips/:id/revision`，可以兼作一次轮询。在线状态按用户记录（同一用户开着几个编辑页也只算一个，其中一个页面发送 `active=false` 后，其它页面的下一次心跳会恢复），只保存在服务端进程的内存里（单实例部署；服务端重启后清空，客户端下一次心跳即恢复）。

`PUT /trips/:id/plan`（🔐 成员）请求：
```json
{
  "base_revision": 42,
  "force": false,
  "trip": { "title": "杭州三日", "days": 3 },
  "waypoints": [
    { "id": 101, "client_key": "w101", "day": 1, "note": "先吃饭" },
    { "client_key": "tmp-1", "kind": "stop", "day": 1, "name": "楼外楼", "address": "孤山路30号",
      "lng": 120.14, "lat": 30.25, "category": "food", "amap_id": "B023B0J1V1",
      "province": "浙江省", "city": "杭州市", "district": "西湖区", "planned_at": "2026-05-01T12:00:00+08:00" },
    { "id": 105, "client_key": "w105", "kind": "lodging", "day": 1 }
  ]
}
```
- `base_revision`（`force` 不为 true 时必填）：草稿所基于的版本号，即加载（或上次保存返回）的 TripDetail 的 `revision`。它不是服务端的当前版本且 `force` 不为 true 时返回 409（见下），什么都不改
- `force`：为 true 时不检查版本，用草稿覆盖服务端的计划（「仍然保存」）
- `trip`（可选）：旅程字段，同 `PATCH /trips/:id` 的请求体，规则也相同（如只有作者能改 `visibility` / `live_share`，天数减少时打卡点与住宿的处理）；其中的 `space_id` 被忽略（所属空间用 `PATCH /trips/:id` 修改）
- `waypoints`（必填）：**完整的计划列表**（游玩点与住宿），列表顺序就是新的顺序（`seq`）。旅程已有的点不限数量；一次最多新建 1000 个（不带 `id`、以及 `force` 时按草稿重新创建的项），超出返回 400 `单次最多新增 1000 个地点`：
  - 带 `id` 的项修改该打卡点，字段同 `PATCH /waypoints/:id`，没有给出的字段保持不变（`{"id": 101}` 表示不修改、只参与排序）；
  - 不带 `id` 的项新建计划内的点（`planned=true, status=todo`），字段同 `POST /trips/:id/waypoints`（`lng` / `lat` 必填，`kind: "lodging"` 为住宿）；
  - 列表中没有的计划内的点被删除（照片、评论保留并取消关联）——**已到达（`status=visited`）或关联了照片的点不会被删除**，保留并在响应的 `kept` 中列出；
  - 计划外的打卡点（`planned=false`，旅行中「我到了」新增的点，以及照片自动生成的点）不属于计划：不在列表中时保持不变；也可以放进列表修改内容、调整位置（仍是计划外）。不在列表中的点（计划外的点与 `kept` 中的点）排在原来它们前面的那个列表中的点之后，所以没有改动、位置也没变的计划外打卡点可以不放进列表（网页端这样做，打卡很多的旅程请求也不会太大）；
  - 项中的 `status`、`planned`、`arrived_at`、`seq` 被忽略：保存计划不会改动打卡记录（到达 / 跳过用「按路线出行」的接口）；`place_id` 也被忽略，关联的地点同单个接口一样由服务端按 `amap_id` 或名称与位置确定；
  - `client_key`（可选，≤64 个字符，不能重复）：客户端给这一项起的名字，响应的 `id_map` 返回它保存后的 ID。建议每一项都带（已有的点可用如 `"w101"`）；
  - 校验同单个打卡点接口（坐标、`day` 0–365、分类、屏蔽词等）；住宿每晚最多一个，新增或改到另一晚的住宿 `day` 为 0 到旅程天数（规则同 `POST /trips/:id/waypoints`）。两项住宿在同一晚时返回 409。某一晚原有的住宿要保留（已到达或有照片、不在列表中）而列表为这一晚安排了别的住宿时，原来那家改为当天的游玩点（`kind=stop`，到达记录不变），在 `kept` 中列出；
  - 带 `id` 的项在服务端已不存在（被别人删除）时：不带 `force` 返回 400（`地点 <id> 不在这个旅程中，请刷新后重试`；版本号已变时先返回 409）；`force=true` 时按该项的字段重新创建为新的计划点（`planned=true, status=todo`；需带齐 `name`、`lng`、`lat` 等字段），`id_map` 中是新的 ID
- 在旅程锁内、一个事务中完成，只产生一个新版本；与服务端完全相同的计划不产生新版本

成功响应：
```json
{
  "trip": TripDetail,
  "id_map": { "tmp-1": 123, "w101": 101, "w105": 105 },
  "kept": [102],
  "deleted": [103, 104]
}
```
- `trip`：保存后的旅程，其 `revision` 即新的版本号（下一次保存的 `base_revision`）
- `id_map`：请求中每个带 `client_key` 的项 → 保存后的打卡点 ID
- `kept`：不在列表中、因已到达或有照片而保留的计划内的点；`deleted`：被删除的点

版本冲突（`base_revision` 不是当前版本）返回 409：
```json
{
  "error": { "code": "conflict", "message": "行程已被 小美 修改" },
  "revision": 43, "updated_by": UserBrief | null, "updated_at": "2026-09-29T10:01:00+08:00"
}
```
`message` 为「行程已被 <昵称> 修改」；最后修改的是自己时为「行程已在你的其他页面或设备上修改」，未知时为「行程已被修改」。客户端可以让用户选择：重新加载（放弃本地修改，或重新获取后把本地修改应用上去再保存），或者「仍然保存」（`force=true`，覆盖别人的修改）。

某一项有错时（400 / 409），`message` 以「第 N 项：」开头（N 从 1 开始），响应另带该项在 `waypoints` 中的下标 `index`（从 0 开始），客户端可据此标出出错的地点：
```json
{ "error": { "code": "conflict", "message": "第 7 项：第 2 天晚上已有住宿（第 6 项）" }, "index": 6 }
```

### 打卡点
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/waypoints` | 🔐 成员 | 创建 → Waypoint |
| POST | `/trips/:id/waypoints/batch` | 🔐 成员 | `{items: [同上]}` → `[Waypoint]` |
| PATCH | `/waypoints/:id` | 🔐 成员 | 修改 → Waypoint |
| DELETE | `/waypoints/:id` | 🔐 成员 | 删除（照片保留，`waypoint_id` 置空）；打卡点已不存在时也返回 `{}`，见下 |
| DELETE | `/trips/:id/waypoints/:wid` | 🔐 成员 | 删除该旅程的打卡点，总是返回 `204`（无响应体），见下 |
| PUT | `/trips/:id/waypoints/order` | 🔐 成员 | `{ids: [..]}` 全量排序 → `[Waypoint]` |
| POST | `/trips/:id/lodging` | 🔐 成员 | 设置住宿（可连住几晚、沿用前一晚），见下 → `[Waypoint]` |
| POST | `/trips/:id/arrange` | 🔐 成员 | 一键规划路线：把「想去」的地点分到各天并排好顺序，见下 |

创建 / 修改请求体：
```json
{
  "name": "楼外楼", "address": "孤山路30号", "lng": 120.14, "lat": 30.25, "coord_type": "gcj02",
  "day": 1, "kind": "stop", "category": "food", "planned": true, "status": "todo", "planned_at": "…", "arrived_at": "…",
  "note": "", "verdict": "recommend",
  "rating": 4, "cost": 150, "amap_id": "B023B0J1V1", "seq": 3
}
```
- `seq` 可选：插入到指定位置，缺省追加到末尾（住宿缺省放在当天最后一个点之后）
- `kind` 可选：`stop`（缺省） | `lodging`，其它值返回 400。住宿（新建、批量新建、修改 `kind` / `day` 时）校验：`day` 为 0 到旅程天数（旅程还没有天数时须 ≥ 1，天数随之增加），超出返回 400；该晚已有住宿返回 409 `第 N 天晚上已有住宿，请先修改或删除原来的住宿`（`day=0` 为「出发前一晚」）。住宿的 `planned` 总是 true（请求中的 `planned=false` 被忽略），缺省 `category=hotel`。把住宿改到另一晚（或把游玩点改为住宿）且未给 `seq` 时，它移到那一天最后一个点之后
- `planned` 缺省：旅程 `phase=planning` 时为 true，否则为 false；`status` 缺省：计划内为 `todo`，计划外为 `visited`（`arrived_at` 缺省为当前时间）
- 服务端根据坐标自动补全 `province` / `city` / `district`（配置了高德 Key 时补全区县与街道地址）；`name` 为空时用地址或区县名
- 带 `amap_id` 时，只关联到按高德 POI 数据（名称、地址、坐标、电话）建立的 Place：需要服务端配置了高德 Key、能查到该 POI，且打卡点距该 POI 不超过 5 公里；否则与未带 `amap_id` 的打卡点一样按名称匹配
- 名称相同且 100 米内已有公开地点（或自己参与的旅程中已用过的地点）时关联到同一个 Place；否则对用户填写了名称的打卡点新建 Place（不带 `amap_id`）。私密旅程里填写的名称、地址和坐标不会通过同名匹配或 AI 规划暴露给其他用户
- `PATCH /waypoints/:id` 中 `name` 与当前名称相同时视为未修改（不会把自动生成的名称当作用户填写的名称去新建地点），客户端提交整张表单时可以原样带上 `name`
- 删除打卡点是幂等的：连点两次「删除」、或别的成员已经删掉了，都不会报错。推荐用 `DELETE /trips/:id/waypoints/:wid`：请求者是该旅程的成员时，无论这次删除了它、它已不存在还是不属于这个旅程（后者不会被删除），都返回 `204 No Content`（无响应体）；非成员同其它旅程接口（404 / 403）。`DELETE /waypoints/:id` 在打卡点已不存在时也返回 `{}`（打卡点存在但请求者无权编辑时仍为 404 / 403）。删除（包括住宿）与其它修改一样使版本号 +1（已不存在时不变）

`POST /trips/:id/lodging` 请求（打卡点的创建字段 + 以下字段，`kind` / `seq` 被忽略）：
```json
{ "day": 1, "nights": 2, "name": "临海古城客栈", "lng": 121.126, "lat": 28.857, "amap_id": "B0…", "cost": 300,
  "copy_from": 123, "replace": false }
```
- `day`（必填）：从第几天晚上开始住（0 为出发前一晚）；`nights`（1–30，缺省 1）：连住几晚，每晚生成一条住宿（`day` 依次加 1）
- `copy_from`（可选）：同一旅程中另一个打卡点的 ID（如前一晚的住宿，或「想去」里的某个酒店），沿用它的名称、地址、坐标、`amap_id`、区县、分类（住宿还沿用备注与人均）；请求中给出的字段优先。「和前一晚一样」即 `{"day": 3, "copy_from": <第 2 晚住宿的 id>}`
- `replace`（可选，缺省 false）：先删除这几晚已有的住宿（照片、评论保留并取消关联）；为 false 且某晚已有住宿时返回 409，全部不创建
- 响应：新建的住宿 `[Waypoint]`（按 `day`）。修改 / 删除住宿用 `PATCH` / `DELETE /waypoints/:id`

`POST /trips/:id/arrange`（一键规划路线）请求：
```json
{ "scope": "pool", "mode": "auto", "apply": false, "days": 3, "fixed": { "123": 2 } }
```
- `scope`：`pool`（缺省）只安排「不分天」（`day=0`）的计划点：已分到第 1…days 天的计划点保持所在天和先后顺序（「按自己的路线」），新安排的点插入到各天路程最短的位置；`all`：重新安排全部还没到达的计划点（`status=todo`；已到达 / 跳过的点和计划外的点不动）
- `days`（可选，1–60）：分到第 1…days 天，缺省为旅程天数；旅程没有天数时按约每天 5 个点。设置了日期的旅程不能超过日期的天数（400）
- `fixed`（可选）：`{打卡点 ID: 第几天}`，把这些点固定在某天（仍会排序）；不是该旅程的计划游玩点，或天数超出范围时返回 400
- `mode`：`auto` | `walking` | `riding` | `driving` | `transit`，缺省为旅程的 `travel_mode`，只用于估算各天的路程与耗时
- 规则：每天从前一晚的住宿出发、到当晚的住宿结束（没有住宿时第 1 天从第一个点出发，之后各天从前一天结束的地方接着走）；按地理位置分组（有住宿的天以住宿为中心，同一家住几晚或没有住宿的天用确定性的 k-means++ 选取中心），每天最多 ⌈点数 / 天数⌉ 个点（固定在某天的点更多时除外）；没有住宿区分的几天按「离前一天最近」排列，第 1 天是包含旅程第一个点的那组；每天内部按最近邻 + 2-opt 排出直线距离最短的顺序。结果是确定的（同样的数据得到同样的安排）
- `apply=false`（缺省）只返回方案，不修改旅程，客户端可以预览；`apply=true` 按方案保存：修改各点的 `day`，并把整个旅程的 `seq` 重新编号为 0…n−1（出发前一晚的住宿在最前；每天依次为：不参与安排的点（已到达等）、安排好的点、当晚住宿；最后是「不分天」的点）；没有日期的旅程天数不足时把天数设为 `days`。与其它打卡点修改一样在旅程锁内完成
响应：
```json
{
  "scope": "pool", "mode": "auto", "days": 2, "applied": false, "changed": 6,
  "items": [{ "id": 11, "day": 1, "seq": 0 }, { "id": 15, "day": 1, "seq": 3 }],
  "day_totals": [{ "day": 1, "ids": [11, 12, 13], "stops": 3, "distance_m": 55038, "duration_s": 8369,
                   "start_lodging_id": null, "end_lodging_id": 15 }],
  "waypoints": [Waypoint]
}
```
- `items`：该旅程**全部**打卡点（含住宿）在新顺序中的 `day` 与 `seq`，按 `seq` 排列；`changed`：`day` 或 `seq` 会变化的点数
- `day_totals`：第 1…days 天各一项，`ids` 为当天安排的游玩点（按顺序，不含住宿），`distance_m` / `duration_s` 为按直线估算的当天路程与耗时（从前一晚住宿到当晚住宿，规则同 `legs` 的估算），`start_lodging_id` / `end_lodging_id` 为当天出发 / 结束的住宿
- `waypoints`：仅 `apply=true` 时返回，保存后的全部打卡点（同 TripDetail 中的顺序）

### 按路线出行（旅行中）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/checkin` | 🔐 成员 | 「我到了」：见下 |
| POST | `/waypoints/:id/checkin` | 🔐 成员 | 标记计划点已到达 `{arrived_at?}` → Waypoint |
| POST | `/waypoints/:id/skip` | 🔐 成员 | 标记计划点跳过 → Waypoint |
| POST | `/waypoints/:id/reset` | 🔐 成员 | 恢复为 `todo`（仅计划内） → Waypoint |
| GET | `/trips/:id/recommend` | 🔐 成员 | 下一站推荐，见下 |
| GET | `/trips/:id/compare` | 🔓（按旅程可见性） | 计划 vs 实际对比，见下 |
| GET | `/trips/:id/legs` | 🔓（按旅程可见性） | 每天路线（前一晚住宿 → 当天计划点 → 当晚住宿）各段的路程、耗时、推荐出行方式与实际路线，`?mode=auto` / `walking` / `riding` / `driving` / `transit`（缺省为旅程的 `travel_mode`）`&geometry=1`，见下 |
| POST | `/ai/plan` | 🔐 | AI 规划路线，见下 |
| POST | `/ai/plan/stream` | 🔐 | 同 `/ai/plan`，以 SSE（`text/event-stream`）推送进度与结果，见下 |
| POST | `/ai/preferences` | 🔐 | AI 帮写「偏好和要求」，见下 |

开始旅行 / 结束旅行：`PATCH /trips/:id {"phase": "ongoing" | "finished"}`。

`POST /trips/:id/checkin` 请求：
```json
{ "lng": 120.1, "lat": 30.2, "coord_type": "wgs84",
  "name": "", "address": "", "amap_id": "", "category": "", "note": "", "waypoint_id": null,
  "arrived_at": "…", "client_id": "…" }
```
- 指定 `waypoint_id`：标记该计划点已到达
- 否则：200 米内存在 `todo` 计划点（含住宿）→ 标记已到达（取距离最近的；与最近距离相差 20 米以内视为同一位置，取 seq 最小的；同一家酒店连住几晚时取最早那晚的住宿）；否则新建计划外打卡点（`planned=false,status=visited`），插入在实际路线中最后一个已到达点之后（所有已到达点都有 `arrived_at` 时按到达时间排序，否则按 `seq`）；未给名称时用逆地理结果命名
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
  "warnings": [{ "place_id": 9, "name": "…", "distance_m": 300, "reason": "5 人踩雷：排队久；价格贵" }],
  "ai_text": "现在是傍晚，建议先去…" | null, "ai_used": true
}
```
- `source`: `plan`（计划中的后续点） | `community`（社区公开打卡的高分地点） | `amap`（高德周边搜索） | `ai`（AI 推荐）
- `reason`：推荐理由，不含距离（距离见 `distance_m`，由客户端显示）
- `next_planned`：最后一个已到达的计划点之后的第一个 `todo` 计划点（中途漏打卡 / 跳过的点不计）；之后没有时取最早的 `todo` 计划点。`source=plan` 的建议按同样顺序，之前漏掉的计划点排在后面，理由为「计划中尚未去的站点」
- 住宿参与这一顺序：第 N 天晚上的住宿排在第 N 天的计划点之后，所以当天的点都去过（或跳过）后，下一站是今晚的住宿（`next_planned.kind=lodging`，建议理由「今晚的住宿」）。已经过去的那些晚（设置了开始日期时早于今天的晚上，或之后已有到达的计划点）的住宿不再推荐
- `ai=true` 且服务端配置了 AI 时，把位置、时间、已去/未去的点、候选地点交给大模型挑选并给出理由；失败时自动退回规则推荐
- `warnings`：附近（2 公里内）至少 2 人标记踩雷且踩雷多于推荐的地点；踩雷多于推荐的地点不会出现在 `suggestions` 中。`reason` 形如「2 人踩雷：排队久；价格贵」，最多列出 3 条不同的备注（每人取最新一条，相同的备注只显示一次）

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
住宿不是打卡点：不计入 `planned.count`、`completion_rate`、`visited` / `skipped` / `todo` / `extra` 与 `days`，另在 `lodging: [Waypoint]` 中列出（按 `seq`）。`planned.path` 只连计划游玩点；`actual.path` / `actual.distance_km` 为实际走过的路线，包含已到达的住宿（回酒店的路程也算），`actual.count` 为已到达的游玩点数（同 TripCard 的 `visited_count`）。

`GET /trips/:id/legs?mode=auto&geometry=1` 响应：
```json
{
  "mode": "auto",
  "legs": [
    { "from_id": 10, "to_id": 11, "day": 1, "mode": "walking", "recommended_mode": "walking",
      "distance_m": 1180, "duration_s": 900, "straight_m": 946, "estimated": false,
      "polyline": [[121.12601, 28.85702], [121.12833, 28.85611], [121.13, 28.855]] },
    { "from_id": 11, "to_id": 14, "day": 1, "mode": "riding", "recommended_mode": "riding",
      "distance_m": 3900, "duration_s": 1080, "straight_m": 2700, "estimated": true,
      "polyline": [[121.13, 28.855], [121.15, 28.87]] }
  ],
  "days": [
    { "day": 1, "stops": 3, "distance_m": 5080, "duration_s": 1980, "estimated": true, "start_lodging_id": 10, "end_lodging_id": 15 },
    { "day": 0, "stops": 1, "distance_m": 0, "duration_s": 0, "estimated": false, "start_lodging_id": null, "end_lodging_id": null }
  ],
  "pending": 1
}
```
- 每天的路线：前一晚的住宿（`day=N−1` 的住宿，第 1 天为出发前一晚 `day=0` 的住宿，没有则从当天第一个点开始）→ 当天的计划游玩点（按 `seq`）→ 当晚的住宿（没有则在最后一个点结束）；`legs` 为其中相邻两点之间的一段（`from_id` / `to_id` 可以是住宿的 ID），不跨天，计划外打卡点不参与。某天没有游玩点、但前后两晚住在不同的地方时，只有一段「换酒店」；同一家酒店则没有路段。「不分天」（`day=0`，想去的地方）的点只在没有任何一天安排了计划游玩点时按 `seq` 相连（这时它就是整条路线，路线预览按它播放），没有住宿；已经有天安排了游玩点时它们只是备选，没有路段（`days` 里仍列出 `day=0` 一项，路程为 0），不会为没人看的路段消耗高德配额
- `mode`（请求参数，缺省为旅程的 `travel_mode`，旧数据为 `auto`）：`auto` 每段用推荐的方式；`walking` / `riding` / `driving` / `transit` 每段都用该方式（`transit` 下直线距离 1 公里以内的路段、以及高德查不到公交地铁且直线不超过 30 公里的路段按步行）。响应中的 `mode` 为请求（或缺省）的方式，每段的 `mode` 为该段实际采用的方式
- `recommended_mode`：该段推荐的出行方式：直线 1.2 公里以内 `walking`，4 公里以内 `riding`（共享单车），更远 `driving`；旅程的 `travel_mode` 为 `transit` 时更远的路段推荐 `transit`。3D 回放 / 路线预览在路段上显示的图标是每段的 `mode`（路线与用时都按它计算）；`recommended_mode` 与 `mode` 不同时字幕另外提示「推荐…」
- `polyline`：仅 `geometry=1` 时返回，该段的实际路线 `[[lng, lat], …]`（GCJ-02，5 位小数，从起点到终点），来自高德路径规划（步行 / 驾车 / 骑行的道路，公交地铁为步行段 + 公交地铁线路，火车为站点间直线），经 Douglas–Peucker 抽稀（约 20 米，长途路段更粗）；估算的路段（`estimated=true`）为起终点两点直线
- 服务端配置了高德 Key 时用高德路径规划计算（`estimated=false`）；未配置、调用失败或未能在约 4 秒内算完的路段按直线距离估算（`estimated=true`：路程取直线的 1.3 倍（驾车 1.4 倍）；步行 1.2 米/秒；骑行 4 米/秒另加 2 分钟；公交地铁 6 米/秒另加 10 分钟；驾车 8 米/秒另加 3 分钟；直线 50 公里以上的公交地铁 / 驾车按 20 米/秒）。高德结果（含抽稀后的路线）缓存 7 天，估算的路段会在之后的请求中逐步换成高德结果
- `pending`：因时间不够（约 4 秒的预算，或高德请求排队已满）还没算好的路段数。大于 0 时客户端可在 3–5 秒后用同样的参数再请求一次（已算好的路段来自缓存，很快），直到为 0 或连续几次不再减少；因未配置高德、距离过长、城市未知等原因只能估算的路段不计入
- 公交地铁需要两端的城市（打卡点的 `city`，为空时按坐标离线判断），无法确定时按估算；直线超过 30 公里的步行、50 公里的骑行、150 公里的公交地铁、1000 公里的驾车路段只估算
- `days`：每个有计划游玩点或路段的天一项，按天排序，`day=0`（未分天）排在最后；`stops` 为当天的计划游玩点数（不含住宿），`distance_m` / `duration_s` 为当天各路段之和（不含停留游玩时间），`estimated` 表示当天有估算的路段，`start_lodging_id` / `end_lodging_id` 为当天出发 / 结束的住宿（没有时为 `null`）
- 权限同 `GET /trips/:id`（游客可看公开旅程，持 `share_code` 可看「链接可见」旅程；旅行中未开启 `live_share` 时非成员只看到计划路线，本接口本来就只用计划点）。会消耗站点的高德配额：旅程成员不限；其他人（含游客，按账号或 IP）每 10 分钟前 20 次请求可以调用高德，超出后只返回已缓存的高德路线和估算值（仍为 200）

`POST /ai/plan` 请求：
```json
{ "destination": "杭州", "days": 3, "preferences": "情侣、喜欢美食和拍照，不想太累", "start_date": "2026-10-01" }
```
响应：
```json
{ "title": "杭州三日·美食拍照之旅", "summary": "…",
  "items": [{ "day": 1, "kind": "stop", "name": "断桥残雪", "address": "…", "city": "杭州市", "district": "西湖区",
              "category": "scenic", "note": "建议清晨去，人少好拍",
              "lng": 120.15, "lat": 30.26, "located": true, "amap_id": "…", "place_id": null },
            { "day": 1, "kind": "lodging", "name": "杭州湖滨XX酒店", "address": "…", "city": "杭州市", "district": "上城区",
              "category": "hotel", "note": "住湖滨，第二天出发近",
              "lng": 120.16, "lat": 30.26, "located": true, "lodging_verified": true, "amap_id": "…", "place_id": null }] }
```
- 仅在 `ai_enabled` 时可用，否则返回 400 `未配置 AI 服务`
- 返回的是建议，不会自动保存。客户端可在用户确认后通过 `POST /trips` + `POST /trips/:id/waypoints/batch` 保存
- `kind`：`stop`（游玩 / 用餐地点）| `lodging`（第 `day` 天晚上的住宿：多日行程每晚一家真实的酒店 / 民宿，`day` 为 1 到天数 − 1，不计入每天的地点数）。保存时把 `kind` 原样传给 `POST /trips/:id/waypoints/batch` 即成为住宿（旧客户端不传 `kind` 时住宿按普通的酒店类打卡点保存）
- `city` / `district`：所在地级市、区县（高德定位后为高德的结果，否则为 AI 给出的）
- 地点校正（`located=true`）：先把目的地解析为省或地级市（离线行政区划；不是省市名称时如「阳朔」「千岛湖」用高德地理编码找到所在的市），再用 AI 给出的准确名称在高德关键字搜索中**限定该市**（AI 给出的城市在同省或邻近时限定那个城市）查找，查不到时再查输入提示；从结果中按名称相似度（忽略括号里的分店名）、类别是否一致、区县是否一致、离目的地中心的距离挑选最匹配的一个，不会选用停车场、公交站、出入口等同名设施，或类别不符的同名店铺（如「神仙居农家乐」之于景区「神仙居」）；都不够相似时不定位。定位后 `name` / `address` / `city` / `district` / 坐标取高德的数据
- 无法定位的项 `located=false`：AI 自己给出的坐标只有在目的地（地级市，目的地为省时为该省）范围内才保留，否则 `lng` / `lat` 为 `null`；客户端应请用户确认或在地图上选择这些地点
- 未经高德定位（`located=false`）但按名称匹配到社区地点（`place_id` 非空）的项，坐标取该地点的坐标
- `lodging_verified`（住宿项）：定位到的是高德「住宿服务」类的地点（酒店、宾馆、民宿、客栈等），即一家真实的住处，而不是 AI 只写了地名（如「洱海」）被定位到的湖泊、景区或镇；游玩点与没有定位的项为 false。客户端可以直接采用 `located && lodging_verified` 的住宿，其余住宿请用户确认住哪一家
- 失败时返回 `500 internal`，message 说明原因，可直接展示：`AI Key 无效或没有权限（HTTP 401：…）…`（401，或带服务商错误信息的 403）、`AI 账户余额不足，请在 DeepSeek 平台（platform.deepseek.com）充值（HTTP 402）`（其它服务商为 `AI 账户余额或额度不足…`）、`模型不存在：<模型名>…`、`AI 服务请求过于频繁或并发超限（HTTP 429）…`、`AI 服务繁忙（HTTP 503，服务器过载）…`、`AI 响应超时（等待了 N 秒），可在设置中换用更快的模型或关闭深度思考`（回复已开始但太慢）、`请求已发出，但 AI 服务（<主机>）在 N 秒内没有任何响应…`、`无法连接 AI 服务（<主机>）：<失败环节与原因>`（DNS、代理、TCP、TLS；网络故障不会被说成 Key 无效或模型太慢）、`AI 返回的内容无法解析，请重试` 等
- 生成多日行程通常需要 10–60 秒（服务端超时 `TRIPHUB_AI_TIMEOUT`，缺省 120 秒）。网页端建议使用下面的流式接口显示进度；App 等不便处理 SSE 的客户端继续用本接口，并把请求超时设为 2 分钟以上

`POST /ai/preferences`（AI 帮写「偏好和要求」）请求：
```json
{ "destination": "台州", "days": 2, "start_date": "2026-10-01", "together": true, "draft": "不想太累" }
```
响应：
```json
{ "suggestions": ["节奏轻松，每天不超过 4 个景点", "想吃地道的台州海鲜", "喜欢古城街巷，适合拍照"],
  "text": "不想太累，节奏轻松，每天不超过 4 个景点，想吃地道的台州海鲜。" }
```
- `destination` 必填（≤30 字）；`days`（1–15）、`start_date`（用于季节）、`together`（情侣同行）、`draft`（用户已写的偏好，≤300 字）可选
- `suggestions`：3–5 条（偶尔更少）不同方面（节奏、预算、同行人、饮食、拍照、兴趣等）的短句（每条 ≤40 字，不重复草稿里已有的），客户端显示为可点击追加到偏好输入框的标签；`text`：把草稿与合适的建议整合成的一段偏好（≤300 字，可整体替换输入框），可能为空字符串
- 仅在 `ai_enabled` 时可用，否则返回 400 `未配置 AI 服务`；与 `/ai/plan` 共用每人每小时 30 次的 AI 频率限制；不开深度思考、不流式，服务端最多等待 20 秒（`TRIPHUB_AI_TIMEOUT` 更短时以其为准）；失败时返回 `500 internal`，message 同 `/ai/plan` 的错误说明（AI 没给出可用建议时为 `AI 没有给出建议，请重试`）

`POST /ai/plan/stream`：请求体、登录要求与频率限制同 `POST /ai/plan`（两者合计每人每小时 30 次）。参数错误、未登录、未配置 AI（400）、超出频率（429）等在开始推送之前以普通 JSON 错误返回；之后响应为 `200`，`Content-Type: text/event-stream`（不压缩，带 `Cache-Control: no-cache`、`X-Accel-Buffering: no`，经 Nginx 反向代理时无需额外配置），事件依次为：

```
event: progress
data: {"stage":"thinking","chars":0,"message":"AI 正在构思行程…"}

event: progress
data: {"stage":"writing","chars":356,"message":"AI 正在生成行程（已生成 356 字）…"}

: ping

event: progress
data: {"stage":"locating","chars":1520,"message":"正在用地图核对 12 个地点的位置…"}

event: result
data: {"title":"杭州三日·美食拍照之旅","summary":"…","items":[…]}
```
- `progress`：`stage` 为 `thinking`（模型在思考；开启深度思考的模型会持续报告已思考的字数）、`writing`（正在输出行程，`chars` 为已生成的字数）、`locating`（正在用地图校正地点坐标）；`message` 为可直接显示的中文进度。进度事件最多约每秒 2 次，阶段变化时立即发送
- `: ping`：SSE 注释行，等待期间每 10 秒一次，用于保持连接，客户端忽略即可
- 最后一个事件是 `result`（`data` 与 `POST /ai/plan` 的响应完全相同）或 `error`（`data` 为 `{"message": "…"}`，内容同 `POST /ai/plan` 的错误 message），之后服务端关闭连接
- 浏览器的 `EventSource` 只支持 GET，网页端用 `fetch` 读取响应流并按空行分隔事件解析；模型服务商不支持流式输出时服务端会自动改用普通请求，客户端无需处理（此时可能只有开始和 `locating` 两个进度）

### 照片
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/trips/:id/photos` | 🔐 成员 | 上传，见下 |
| PATCH | `/photos/:id` | 🔐 成员 | `{caption?, waypoint_id?}`（waypoint_id 传 0 取消关联）→ Photo |
| DELETE | `/photos/:id` | 🔐 成员 / 上传者 | 删除；照片已不存在（如连点两次）时也返回 `{}`。上传者总可以删除自己的照片（占用的是自己的存储空间），即使已不再是旅程的成员（如被移出） |
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
| DELETE | `/comments/:id` | 🔐 | 作者 / 旅程作者 / 管理员；已删除的评论再次删除返回 `{}` |

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
| GET | `/geo/pick` | 🔐 | `?lng=&lat=&coord_type=` 在地图上点选位置：所在的景区 / 园区、附近的地点和地址，见下 |
| GET | `/geo/atlas` | 🔓 | 中国省/市边界 TopoJSON（对象 `provinces` / `prefectures` / `nation`，属性 `id`=区划码、`地名`） |

`/geo/search` 响应：
```json
{ "source": "amap", "items": [{ "amap_id": "B0…", "name": "楼外楼", "address": "孤山路30号",
  "province": "浙江省", "city": "杭州市", "district": "西湖区", "category": "food",
  "lng": 120.14, "lat": 30.25, "amap_rating": 4.6, "amap_cost": 135,
  "place": { "id": 12, "checkin_count": 8, "recommend_count": 2, "neutral_count": 1, "avoid_count": 5, "rating_avg": 2.4 } }],
  "amap_error": "高德 Key 的服务平台不是「Web服务」：…" }
```
- `source`：结果来源。`amap`：高德（同时查询关键字搜索与输入提示并合并：按 `amap_id` 去重，名称与关键词完全相同 / 以关键词开头的排在前面，能搜到只出现在输入提示里的小店、民宿；关键词前带城市名如「台州那海民宿」也能匹配「那海民宿」；`city` 或 `lng`/`lat` 所在城市只作为优先范围，不限定结果）；`tianditu`：天地图（未配置高德、高德调用失败或高德没有结果时，服务端配置了天地图 Key 才会使用；`amap_id` 为空字符串）；`local`：离线行政区划，仅能搜索省 / 市名称（返回行政区中心）
- `amap_error`：仅在服务端配置了高德 Key 但调用失败时出现，为可直接展示给管理员的中文原因，例如 `高德 Key 无效（infocode 10001 INVALID_USER_KEY）：…`、`高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key`、`服务器 IP 不在高德 Key 的白名单中（infocode 10005）：…`、`高德调用额度已用完（infocode 10003）…`、`该 Key 没有此接口权限（infocode 10012）`、`服务器无法连接高德（restapi.amap.com）：<失败环节与原因>`、`高德接口响应超时（restapi.amap.com）：…`，其它错误带 infocode。Key 无效 / 额度用尽等错误会让服务端暂停调用高德 10 分钟；网络故障（含超时、HTTP 错误状态和不是高德数据的应答）在不同时刻连续 3 次才暂停 20 秒（相隔不到 2 秒发出的请求只算一次，如一次搜索并发的两个请求），高德有任何应答即重新计数；单次请求最长等待 10 秒。暂停期间返回同一原因并注明「已暂停调用高德，稍后自动重试」。此时结果来自天地图或离线行政区划，`source` 相应为 `tianditu` / `local`。`/geo/around`、`/geo/pick` 中的 `amap_error` 含义相同
- `place`：该高德 POI 对应地点的社区统计（同 Place 中的同名字段，便于规划时提示「踩雷」），该 POI 还没有公开打卡时为 `null`；`source` 为 `tianditu` / `local` 时总为 `null`
- `amap_rating` / `amap_cost`：高德的商户评分（0–5）与人均消费（元），未知或非高德结果时为 0
- 高德与天地图返回的坐标都已转换为 GCJ-02；天地图结果缺少省 / 市时按坐标离线补全

`/geo/search`、`/geo/regeo`、`/geo/around`、`/geo/pick` 会消耗站点的地图服务调用额度，因此需要登录，且每人 10 分钟最多 120 次（合计），超出返回 429。

`/geo/around` 响应：`{ "source": "amap", "items": [...] }`，`items` 字段同 `/geo/search`（含 `place`），另加 `distance_m`（距请求坐标的米数），按距离由近到远，最多 20 个。`radius` 取值 50–5000（缺省 300 米），`keyword` 可选（≤50 字，如店名）。服务端未配置高德 Key 时返回 `{"source": "none", "items": []}`；高德调用失败时返回 `200`：`{"source": "none", "items": [], "amap_error": "…"}`（客户端应显示 `amap_error`，而不是「附近没有地点」）。

`/geo/regeo` 响应：
```json
{ "province": "浙江省", "province_code": "330000", "city": "杭州市", "city_code": "330100",
  "district": "西湖区", "street": "北山街道", "address": "浙江省杭州市西湖区孤山路30号", "spot": "西湖风景名胜区",
  "lng": 120.14, "lat": 30.25 }
```
`spot`：该点所在的景区 / 园区 / 商场等区域（AOI），或 30 米内最近的地点名称，没有时为空字符串（高德不可用时使用天地图，都未配置时为空）。地图点选请使用 `/geo/pick`。
`province` / `city` 来自离线行政区划（海岸附近的海上点位会归到最近的地级市）。高德对海上的点位不返回省份、只返回「中华人民共和国」，这种结果不会被当作地名：`address` 此时为离线行政区划的「省 + 市」。

`/geo/pick` 响应（路线编辑中在地图上点选位置时使用，由用户从候选中选择打卡点名称）：
```json
{
  "address": { "province": "浙江省", "city": "台州市", "district": "椒江区", "street": "大陈镇",
               "address": "浙江省台州市椒江区大陈镇甲午岩景区" },
  "candidates": [
    { "kind": "aoi", "name": "甲午岩景区", "address": "浙江省台州市椒江区大陈镇甲午岩景区", "category": "scenic",
      "amap_id": "B0FFxxxxxx", "place_id": null, "lng": 121.9001, "lat": 28.4502, "distance_m": 0, "place": null },
    { "kind": "poi", "name": "观海亭", "address": "甲午岩景区内", "category": "scenic",
      "amap_id": "B0FFyyyyyy", "place_id": 8, "lng": 121.9002, "lat": 28.4501, "distance_m": 25,
      "place": { "id": 8, "checkin_count": 3, "recommend_count": 2, "neutral_count": 0, "avoid_count": 1, "rating_avg": 4.3 } },
    { "kind": "place", "name": "岛上咖啡", "address": "", "category": "food",
      "amap_id": "", "place_id": 9, "lng": 121.9005, "lat": 28.45, "distance_m": 49, "place": { "id": 9, "…": "…" } },
    { "kind": "address", "name": "大陈镇 · 环岛公路", "address": "浙江省台州市椒江区大陈镇甲午岩景区", "category": "other",
      "amap_id": "", "place_id": null, "lng": 121.9, "lat": 28.45, "distance_m": 0, "place": null }
  ],
  "source": "amap",
  "amap_error": "…"
}
```
- `candidates` 的顺序：`kind=aoi`（区域：景区、校园、商场、小区等）中包含该点的排最前（`distance_m=0`，面积小的在前），其次是附近的区域（按距离）；然后是 200 米内的地点 `poi`（高德 POI）与 150 米内的社区地点 `place`（按距离）；同名的只保留第一个；最多 20 个，最后总有一个 `kind=address`：点击的位置本身（坐标即请求坐标），名称为「乡镇 / 街道 · 道路」（如 `东山街道 · 解放路`），没有时为区县或城市名
- `lng` / `lat`：区域 / 地点自身的坐标（GCJ-02），`address` 为点击位置的坐标；`distance_m`：距点击位置的米数（区域为到其边界的距离）
- `place_id` / `place`：对应的社区地点（按 `amap_id` 或同名关联）及其社区统计（同 `/geo/search` 的 `place`，没有公开打卡时 `place` 为 `null`）。社区地点遵循地点的可见性规则（有公开打卡、带高德 ID、被公开旅程引用，或出现在查看者自己参与的旅程中），其他用户私密旅程中的地点不会出现
- `source`：`amap`（高德逆地理编码）；`tianditu`（未配置高德或高德调用失败时使用天地图：只提供最近的一个地点名称，其坐标取点击位置）；`local`（都不可用：只有社区地点和按离线行政区划命名的地址）
- `amap_error`：同 `/geo/search`
- 海上的点位：高德不返回省份（只有「中华人民共和国」）时，`address` 的省、市取自离线行政区划，`address.address` 为「省 + 市」，附近若有 AOI / POI 仍作为候选返回；「中华人民共和国」不会出现在地址或候选名称中
- 选择 `aoi` / `poi` 候选后，客户端创建打卡点时可带上 `name`、`amap_id` 和候选的坐标；选择 `address` 时可只传坐标（名称留空由服务端自动命名）或使用候选的 `name`

### 空间「我们」 🔐
用户可以有多个空间（情侣、闺蜜、朋友、家人或自定义类型），各自邀请不同的人（可以多人）。点击「我们」时：设置了默认空间（Me 的 `default_space_id`）就打开它；否则只有一个空间时打开它，有多个空间时打开总览（`GET /spaces`），再点进某个空间。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/spaces` | 🔐 | 我所在的空间 → `[Space]`（数组，不分页，按我加入的先后） |
| POST | `/spaces` | 🔐 | 创建 `{type, name?, type_label?, description?, anniversary?, public?}` → SpaceDetail（我是创建者） |
| GET | `/spaces/:id` | 🔐 空间成员 | SpaceDetail |
| PATCH | `/spaces/:id` | 🔐 创建者（情侣空间：两人都可以） | `{name?, type?, type_label?, description?, anniversary?, public?}`（`anniversary: null` 清除）→ SpaceDetail |
| DELETE | `/spaces/:id` | 🔐 创建者 | 删除空间（情侣空间可带 `?remove_shared_access=true`），见下 → `{}` |
| POST | `/spaces/:id/invites` | 🔐 空间成员（情侣空间：创建者） | 邀请 `{username, message?}` 或 `{user_id, message?}` → SpaceInvite |
| DELETE | `/spaces/:id/members/:user_id` | 🔐 创建者 / 本人 | 移除成员；`user_id` 是自己时为退出空间（情侣空间可带 `?remove_shared_access=true`），见下 → `{}` |
| GET | `/spaces/:id/trips` | 🔐 空间成员 | `?phase=&page=` 关联到空间的旅程 → 分页 TripCard |
| GET | `/spaces/:id/footprints` | 🔐 空间成员 | 空间里全部旅程的 Footprints（格式同个人足迹，可直接用于 3D 足迹） |
| GET | `/space-invites` | 🔐 | `{incoming: [SpaceInvite], outgoing: [SpaceInvite]}`：别人邀请我的、我发出的，都只含待回应的（新的在前） |
| POST | `/space-invites/:id/accept` | 🔐 被邀请人 | 接受 → SpaceDetail |
| POST | `/space-invites/:id/decline` | 🔐 被邀请人 | 拒绝 → `{}` |
| DELETE | `/space-invites/:id` | 🔐 邀请人 / 空间创建者 | 撤回 → `{}` |
| PUT | `/me/default-space` | 🔐 | `{space_id}` 设置默认空间，`null` 或 `0` 清除 → Me |

不是空间成员（包括只被邀请、还没接受的人）请求 `/spaces/:id` 下的接口一律返回 404 `空间不存在或你不是它的成员`；非邀请人、非被邀请人操作邀请返回 404 `邀请不存在或已处理`。

**创建 / 修改**：
- `type`（创建时必填）：`couple` | `besties` | `friends` | `family` | `custom`；`custom` 时 `type_label` 必填（≤10 字，如「驴友团」），其他类型忽略 `type_label`
- `name`（≤30 字）：创建时可以不填，按类型默认为「我们」（情侣）、「闺蜜们」、「朋友们」、「家人们」或自定义类型的名称；修改时不能为空
- `description`（≤120 字）；`anniversary`：`YYYY-MM-DD`，不能晚于今天（东八区）
- `public`：只有情侣空间可以设为 `true`（否则 400）；情侣空间改为其他类型时自动变为 `false`
- 名称、类型名称、简介受屏蔽词检查（见「内容安全」）
- 改为情侣空间：只有空间里只有自己一个人时可以——情侣关系要对方同意（接受邀请），已有其他成员时返回 409 `空间里已有其他成员，不能改成情侣空间…`，请新建一个情侣空间邀请 TA；待回应的邀请最多 1 条（400，被邀请人回应时看到的是新的类型）；自己不能已在另一个情侣空间中（409）
- 类型（含自定义类型的名称）改变时，其他成员和待回应的被邀请人收到 `system` 通知（如「小梅 把空间「周末」改成了「家人」空间」）

**人数上限**：
- 每人最多加入 20 个空间（含自己创建的）：已满时创建返回 400，接受邀请返回 409；邀请已满 20 个空间的人返回 409 `对方加入的空间已达上限`
- 每个空间最多 50 人，情侣空间最多 2 人；**成员加上待回应的邀请**不能超过上限：普通空间返回 400 `空间最多 50 人（含待接受的邀请）`，情侣空间返回 409 `情侣空间只能有两个人`（已有两人）或 `已邀请了另一个人，请先撤回那条邀请`（同一时间只能有一条待回应的邀请）
- 每人只能在一个情侣空间中：已在情侣空间中再创建情侣空间返回 409；邀请已有情侣的人加入情侣空间返回 409 `对方已有情侣`

**邀请**：
- 情侣空间只有创建者可以邀请；其他空间的任何成员都可以邀请
- `username`（可带 `@`，不区分大小写）或 `user_id` 二选一；`message` 为留言（≤200 字，受屏蔽词检查）。都没给时 400；用户不存在或已注销 404；邀请自己、被封禁的用户 400；对方已是成员 409 `对方已在空间中`；已有待对方回应的邀请 409 `已邀请过对方，请等待对方回应`；对方已邀请你加入他的情侣空间时，再邀请他加入你的情侣空间返回 409 `对方已邀请你加入情侣空间，请直接接受`
- 每人每小时最多发出 60 条邀请（含旧接口 `/partner/invites`），超出返回 429
- 通知：被邀请人收到 `space_invite`（`content` 为留言，`space_invite_id` 可直接用于接受 / 拒绝）；接受后邀请人收到 `space_accept`（空间创建者不是邀请人时也收到一条）；拒绝后邀请人收到 `space_decline`；撤回不通知
- 被拒绝或撤回的邀请可以重新发出；邀请人退出或被移出空间时，他发出的待回应邀请自动撤回；空间被删除时它的邀请全部撤回
- 接受情侣空间的邀请后，两人收到的其他情侣空间邀请、以及这个空间其余待回应的邀请都自动撤回（空间已满）。接受者已在另一个情侣空间中时：
  - 那个空间里还有别人：返回 409 `你已在情侣空间「X」中，请先退出或删除它，再接受邀请`；
  - 只有他自己（例如他创建后还在等对方加入，并把邀请链接发给了对方，对方打开链接后发来了邀请）、有旅程，而邀请人的情侣空间没有旅程：**邀请人加入接受者的这个空间**（邀请人的空间被删除），响应的 SpaceDetail 是接受者的空间，邀请人收到 `space_accept`（「…TA 之前建好了情侣空间「X」，你们现在都在这里」）；两人的空间都有旅程时返回 409（请先把其中一个空间的旅程移出或删除那个空间）；
  - 只有他自己、没有旅程：它被删除（其中的邀请一并撤回），接受者加入邀请人的空间；
  - 被删除的一方准备好的名称（不是默认的「我们」时）、纪念日和简介会补到留下的空间里没有填写的对应项上，它是谁的默认空间就改为留下的空间；邀请人搬进接受者的空间时，只有两个空间都公开了情侣关系，留下的空间才保持公开
- 同一邀请同时被接受与撤回 / 拒绝时，只有先完成的操作生效，另一方返回 404 `邀请不存在或已处理`

**空间里的旅程**：
- 旅程用 `space_id` 关联到空间：创建时带 `space_id`，或 `PATCH /trips/:id {"space_id": 3}`（规则见「旅程」）。一个旅程最多属于一个空间，只有作者能把它加入空间（作者必须是该空间的成员）；作者或空间创建者可以把它移出
- **关联的旅程对空间的全部成员开放，权限与已接受邀请的共同作者完全相同**：查看（含私密、被隐藏或待审核的旅程，以及旅行中未公开的实时进度、照片和轨迹）、编辑内容与计划、打卡、上传照片与轨迹、协同编辑、看到分享码、查看成员列表、评论、收藏等；也和共同作者一样不能修改 `visibility` / `live_share`、管理成员、重置分享码或删除旅程（只有作者可以）。空间成员不会出现在旅程的 `members` 里，也不计入旅程的参与者（`/me/trips`、个人足迹、个人主页只含自己是作者或共同作者的旅程）
- 权限随空间成员关系实时生效：被移出或退出空间后立即失去空间带来的权限（是某个旅程的共同作者时，对这个旅程的权限不受影响）；只被邀请、还没接受的人没有任何权限
- 作者退出或被移出空间时，**他的旅程随他离开空间**（仍属于他，不会删除）；其他人的旅程留在空间里。删除空间时全部旅程都保留，只是不再属于该空间
- 旅程离开空间时（作者退出或被移出、作者或空间创建者把它移出或改到别的空间、空间被删除），**在其中添加过打卡点、上传过照片或轨迹的空间成员成为它的共同作者**（已接受，按最早留下内容的先后加入；改到的空间里也有他们时不需要），不会因此看不到、也删不了自己留下的内容；作者可以在旅程「成员」中移除他们
- `GET /spaces/:id/trips` 的顺序：按开始日期（没有日期的按创建日期）由近到远，`phase` 可筛选；TripCard 的 `space` 为该空间
- 在旅程的「成员」中邀请空间成员做共同作者时和邀请别人一样需要对方接受（接受后旅程会出现在对方的「我的旅程」、个人主页和足迹里）；只有作者的情侣直接加入

**退出与移除**（`DELETE /spaces/:id/members/:user_id`）：
- 创建者可以移除任何成员（被移除的人收到 `system` 通知）；其他成员只能移除自己，即退出（创建者收到 `system` 通知）；移除别人返回 403，对方不是成员返回 404
- 创建者退出时，最早加入的成员成为新的创建者（收到 `system` 通知）；最后一个人退出时空间被删除
- 删除空间：只有创建者可以，其他成员收到 `system` 通知
- 情侣空间（分手）：退出、移出对方或删除时可以带 `?remove_shared_access=true`，同时结束两人在彼此旅程中的共同作者关系（含待接受的邀请；同 `DELETE /partner?remove_shared_access=true`）：用「和 TA 一起」创建的旅程、手动把对方加为共同作者的旅程都包括在内，每个受影响的旅程版本号 +1，对方的通知里会说明。不带时共同作者关系不变（对方仍能查看、编辑这些旅程，旅行中也能看到实时位置），可在旅程「成员」中逐个移除；其他类型的空间忽略该参数
- 退出、被移出或空间被删除后，它不再是这些人的默认空间（`default_space_id` 变为 `null`）

**默认空间**：`PUT /me/default-space {"space_id": 3}` 只能设为自己所在的空间（否则 404），`{"space_id": null}` 清除；响应为 Me。Space 的 `is_default` 标出默认空间。

### 情侣空间（旧接口，已弃用） 🔐
旧版客户端使用的接口，仍然可用。它们操作的是用户所在的**情侣空间**（`type=couple` 的空间，每人最多一个）：「绑定情侣」就是情侣空间里有两个人，邀请就是情侣空间的邀请（ID 与 `/space-invites` 相同）。新客户端请使用「空间」接口。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/partner` | `{partner: UserBrief|null, since: "2023-05-20"|null, title: "", bound_at, public: false, space_id: 3|null, invites: {incoming: [PartnerInvite], outgoing: [PartnerInvite]}}` |
| PATCH | `/partner` | `{since?, title?, public?}` 修改情侣空间 → 同 `GET /partner` |
| DELETE | `/partner` | 解除绑定：删除情侣空间。`?remove_shared_access=true` 时同时结束共同作者关系，见下 → `{}` |
| POST | `/partner/invites` | `{username, message?}` → PartnerInvite |
| POST | `/partner/invites/:id/accept` | 接受 → 同 `GET /partner` |
| POST | `/partner/invites/:id/decline` | 拒绝 → `{}` |
| DELETE | `/partner/invites/:id` | 撤回自己发出的邀请 → `{}` |
| GET | `/partner/trips` | 情侣空间的旅程（同 `GET /spaces/:id/trips`；没有情侣时为空）→ 分页 TripCard |
| GET | `/partner/footprints` | 情侣空间的 Footprints（同 `GET /spaces/:id/footprints`；没有情侣时为空） |

- `GET /partner`：`partner` 为情侣空间里的另一个人；有情侣时 `since` 为空间的纪念日、`title` 为空间名称、`bound_at` 为第二个人加入的时间、`public` 为空间的 `public`，没有时依次为 `null`、`""`、`null`、`false`；`space_id` 为自己的情侣空间（只有自己一人时也返回，没有时为 `null`）；`invites` 为待回应的情侣空间邀请
- `PATCH /partner`：需要已有情侣（否则 400 `尚未绑定情侣`），两人都可以修改：`since` → 纪念日（不能晚于今天（东八区）），`title` → 空间名称（≤30 字，空字符串时为「我们」），`public` → 是否在两人的个人主页公开显示情侣关系
- `DELETE /partner`：需要已有情侣（否则 400）。情侣空间被删除（旅程都保留，不再属于该空间），对方收到 `system` 通知。`?remove_shared_access=true` 时同时删除双方在对方创建的旅程中的共同作者身份（含待接受的邀请）；不传时共同旅程的成员关系不变，可在旅程「成员」中移除
- `POST /partner/invites`：邀请对方加入自己的情侣空间，没有情侣空间时自动创建一个名为「我们」的情侣空间。已有情侣时 409 `你已绑定情侣，请先解除绑定`，对方已有情侣时 409 `对方已绑定情侣`；其余规则与通知同 `POST /spaces/:id/invites`
- `accept` / `decline` / `DELETE`：规则同 `/space-invites/:id` 的接受 / 拒绝 / 撤回，只接受情侣空间的邀请（其他空间的邀请返回 404）
- PartnerInvite：`{id, from: UserBrief, to: UserBrief, message, status: "pending", created_at}`，`id` 为空间邀请的 ID

**升级说明**：服务端升级后首次启动时，每一对已绑定的情侣自动变成一个情侣空间：名称为原来的空间名称（没有时为「我们」），纪念日、是否在主页公开不变；创建者为当初发出邀请的一方（查不到时为用户 ID 较小的一方），两人的加入时间为原来的绑定时间；两人共同的旅程（一方创建、另一方是已接受的共同作者）关联到这个空间；它成为两人的默认空间（已有默认空间的不变）。待处理的情侣邀请变为邀请对方加入邀请人的情侣空间（邀请人没有时自动创建）；情侣空间同一时间只有一条待回应的邀请，所以同一个人发出的多条只保留最新的一条，其余的撤回。每对情侣只转换一次，旅程的版本号与更新时间不变。

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
| GET | `/admin/stats` | `{users, trips, public_trips, pending_trips, places, photos, comments, storage_bytes, today: {users, trips, comments}, trend: [{date, users, trips, comments}] (近14天)}`（`pending_trips`：待审核的公开旅程数；`trend` 按东八区日期统计、由旧到新，最后一项即今天，与 `today` 相同，客户端应以它而不是浏览器本地日期标注「今天」） |
| GET | `/admin/users` | `?q=&role=&status=&page=` → 分页 AdminUser（Me 字段 + `trip_count`, `last_login_at`） |
| PATCH | `/admin/users/:id` | `{role?, status?, exp?}` → AdminUser |
| POST | `/admin/users/:id/reset-password` | `{password?}` → `{password}`（不传则生成 12 位随机密码；该用户全部会话的 refresh token 与 access token 立即失效；不能对自己或已注销账号操作） |
| GET | `/admin/trips` | `?q=&status=&visibility=&page=` → 分页 TripCard（`q` 匹配标题、简介、城市和作者的用户名 / 昵称） |
| PATCH | `/admin/trips/:id` | `{featured?, status?}`（`status` 为 `normal` / `hidden`；对 `pending` 旅程即审核通过 / 驳回，见「内容安全」）→ TripCard |
| DELETE | `/admin/trips/:id` | 删除 |
| GET | `/admin/comments` | `?q=&page=` → 分页 Comment（附 `trip: {id,title}`、`place: {id,name}`） |
| DELETE | `/admin/comments/:id` | 删除 |
| GET | `/admin/reports` | `?status=pending|resolved|rejected&page=` → 分页 `{id, reporter: UserBrief, target_type, target_id, target_preview, reason, status, note, created_at, handled_at}` |
| PATCH | `/admin/reports/:id` | `{status, note?}` |
| GET | `/admin/settings` | `{site_name, announcement, registration_open, icp_beian, police_beian, terms_md, privacy_md, sensitive_words, review_public_trips}` |
| PUT | `/admin/settings` | 同上（字段均可选）；`terms_md` / `privacy_md` 为 Markdown，留空表示使用内置模板；`sensitive_words` 屏蔽词（每行一个，也可用逗号分隔，≤100000 字，缺省为空）；`review_public_trips` 公开旅程需审核（缺省 false）。见「内容安全」 |
| GET | `/admin/diagnostics` | 实时检查外部服务的配置，见下 |

`GET /admin/diagnostics` 响应（每次调用都会实时请求各服务，约需几秒，最长约 30 秒；结果中不含任何 Key）：
```json
{
  "amap": { "configured": true, "ok": false, "message": "高德 Key 的服务平台不是「Web服务」：请在高德控制台为本站创建服务平台为「Web服务」的 Key",
            "infocode": "10009", "latency_ms": 85 },
  "ai": { "configured": true, "ok": true, "model": "deepseek-flash", "base_url": "https://api.deepseek.com",
          "thinking": "off", "timeout_s": 120, "latency_ms": 820, "message": "正常：模型回复「ok」（用时 820 毫秒）" },
  "tianditu": { "configured": false, "ok": false, "message": "未配置天地图 Key（TIANDITU_KEY，可选）", "latency_ms": 0 }
}
```
- `amap`：在北京搜索「天安门」（不走缓存，也不受暂停影响；成功后解除暂停）；`infocode` 为高德的错误码（仅失败时出现）
- `ai`：向模型发送一条「只回复 ok」的最小请求（30 秒超时）；`base_url` 中的账号密码与 Key 类查询参数显示为 `***`；`thinking` 为深度思考设置（`off` / `on` / `low` / `high` / `max`），`timeout_s` 为 AI 规划的超时秒数；失败时 `message` 同 `/ai/plan` 的错误说明，`kind` 为错误类别（`auth` / `balance` / `model` / `rate_limit` / `server` / `request` / `network` / `timeout` / `bad_response` / `empty` / `provider`）
- `tianditu`：用天地图搜索北京的「天安门」
- `ok=false` 时 `message` 为可直接展示的中文原因；未配置的服务 `configured=false`

已配置的服务还带有以下可选字段（旧版服务端没有；不含任何 Key），失败时服务端也会以 `diagnostics check failed` 写入日志：

| 字段 | 说明 |
|---|---|
| `host` | 服务的主机名，如 `restapi.amap.com` |
| `key_hint` | Key 指纹：`length`（字符数）、`head` / `tail`（16 位以上的 Key 为首尾各 4 个字符，8–15 位为 2 个，更短的不显示）、`whitespace` / `quotes` / `non_ascii` / `non_hex`（含空白、引号、非 ASCII、非十六进制字符，`sk-` 前缀除外）、`warning`（与常见格式不符时的提示，如高德 / 天地图应为 32 位十六进制，DeepSeek 为 `sk-` 加 32 位十六进制）、`text`（如 `长度 32 · c549…bd36`） |
| `proxy` | 仅在设置了代理环境变量时出现：`https_proxy` / `http_proxy` / `no_proxy`（去掉了账号密码与路径），`used` 为访问该服务实际经过的代理（缺省为直连） |
| `layer` | 仅失败时：失败环节。`dns`（域名解析）、`proxy`（代理不可用）、`connect`（TCP 连接）、`tls`（TLS 握手 / 证书）、`timeout`（已连接并发出请求，但没有收到任何响应）、`network`（连接中断）为没连上服务；`http`（HTTP 错误状态）、`api`（服务返回错误码）、`response`（返回的不是服务商的数据或内容不可用）为服务返回了错误；`slow`（仅 AI：已开始返回，但没有在时限内完成，是模型慢而不是网络问题） |
| `status` | 仅失败时：HTTP 状态码 |
| `blocked` | 仅失败时：返回的不是服务商自己的错误信息（代理、防火墙、WAF 或网络认证页面），与 Key 无关 |
| `detail` | 仅失败时：原始错误（Go 的错误信息，请求 URL 的查询参数与账号密码已去掉）或服务商返回的信息，Key 替换为 `***` |
| `addrs` | 仅失败时：服务域名解析到的地址（请求未做解析时，如经代理访问或复用了连接，服务端会单独解析一次） |
| `proxy_addrs` | 仅经代理访问失败时：代理主机名解析到的地址 |
| `remote` | 仅失败时：已建立连接的对端地址（经代理时为代理的地址） |

```json
{
  "amap": { "configured": true, "ok": false, "latency_ms": 12, "host": "restapi.amap.com", "layer": "proxy",
            "message": "服务器无法连接高德（restapi.amap.com）：经代理 http://127.0.0.1:7890 连接失败：连接被拒绝（connection refused）（…）",
            "detail": "Get \"https://restapi.amap.com/v3/place/text\": proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused",
            "proxy": { "https_proxy": "http://127.0.0.1:7890", "used": "http://127.0.0.1:7890" },
            "key_hint": { "length": 32, "head": "c549", "tail": "bd36", "text": "长度 32 · c549…bd36" } }
}
```

同样的检查也可以在服务器上运行：`docker compose exec app /triphub -diagnose`（见部署文档「常见问题」），它还会逐项测试 DNS、TCP 与 TLS，全部正常时退出码为 0，否则为 1。

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
- 所有成功的删除 / 无返回体操作返回 `{}`（例外：`DELETE /trips/:id/waypoints/:wid` 返回 `204`，无响应体）；创建类接口统一返回 `200`。
- 时间字段统一输出为东八区 RFC3339（如 `2026-09-24T10:00:00+08:00`）；请求中也接受不带时区的 `YYYY-MM-DDTHH:mm[:ss]`（按东八区解释）。
- `coord_type` 缺省为 `gcj02`（包括 `/trips/:id/checkin`、`/trips/:id/recommend`、`/trips/:id/track` 等）；只有 `POST /trips/:id/photos` 缺省为 `wgs84`。
- 频率限制：同一 IP+账号 15 分钟内失败登录 5 次、同一 IP 失败 30 次后返回 429；同一 IP 每小时最多注册 10 个账号；每人 10 分钟最多 30 条评论；AI 接口（`/ai/plan`、`/ai/plan/stream`、`/ai/preferences`、带 `ai=true` 的推荐）每人每小时 30 次；非成员查看路段（`/trips/:id/legs`）每 10 分钟前 20 次可以调用高德（之后只用缓存和估算，不返回 429）；地点搜索 / 逆地理 / 周边地点 / 地图点选每人 10 分钟最多 120 次；空间邀请（`/spaces/:id/invites` 与 `/partner/invites` 合计）每人每小时 60 条；修改密码 / 注销账号时同一账号 15 分钟内密码错误 5 次（超出返回 429）。并发请求同样受限（请求在校验密码前即计入，登录成功后退回）。
- 请求带 `Accept-Encoding: gzip` 时，JSON 响应与网页静态资源以 gzip 压缩返回（SSE 事件流 `text/event-stream` 除外）。
- 常用长度限制：标题 ≤100、简介 ≤500、正文 ≤50000、标签 ≤10 个且每个 ≤20 字（自动去重、去掉 `#`）、昵称 ≤20、个人简介 ≤200、打卡点名称 ≤100 / 备注 ≤5000、批量打卡点 ≤200 个、共同作者 ≤20 人、照片说明 ≤500、空间名称 ≤30 / 自定义类型名称 ≤10 / 空间简介 ≤120 / 空间邀请留言 ≤200、每人最多 20 个空间、每个空间最多 50 人（情侣空间 2 人）。

### 用户
- `Me.next_level_exp` 在满级时为 `null`；管理员的 `storage_quota` 为 `0`（表示不限）。
- `POST /me/password` 会吊销**除当前会话外**的全部会话，其 refresh token 与 access token 立即失效（当前会话由 access token 识别；也可额外传 `refresh_token` 指定保留）。
- `GET /users/:username/trips` 返回该用户作为作者或共同作者参与的旅程（不含只因空间可见的旅程）；`stats.likes` 为其公开旅程获赞总数。
- 忘记密码：由管理员在后台调用 `POST /admin/users/:id/reset-password` 重置。管理员自己忘记密码时在服务器上运行 `docker compose exec app /triphub reset-password -user <用户名>`（二进制部署：`TRIPHUB_DB_DSN=… ./triphub reset-password -user <用户名>`；`-password` 指定新密码，缺省随机生成；`-admin` 同时设为管理员）。配置 `TRIPHUB_ADMIN_PASSWORD` 不会修改已有账号的密码；`TRIPHUB_ADMIN_USERNAME` 指向已注册的普通用户时，只有密码与该用户当前密码一致才会授予管理员权限。

### 旅程
- **分享码访问子资源**：`unlisted` 旅程按 ID 访问时仅成员/管理员可见。通过分享链接浏览的访客，在请求 `GET /trips/:id`、`/trips/:id/track`、`/trips/:id/comments`、`/trips/:id/compare`、`/trips/:id/legs`、点赞 / 评论等旅程子接口时，可附带查询参数 `?share_code=xxx`（或请求头 `X-Share-Code`）获得与公开旅程相同的访问权限。
- `TripDetail.share_code` 仅成员可见，非成员时**不返回该字段**。`TripDetail` 额外返回 `invite_pending`（当前用户有待接受的共同作者邀请时为 true；被邀请人在接受前可预览旅程）。
- `TripCard.summary` 为空时由正文自动截取（最多 120 字）；`TripDetail.summary` 返回原始简介。`cover_url` 未设置时使用第一张照片（旅行中的位置隐私规则下除外）。
- `cities` / `provinces` 按实际路线（`status=visited`，含已到达的住宿）计算，尚无已到达点时退回计划路线；`distance_km` 取 GPS 轨迹里程与已打卡点连线里程（含已到达的住宿）中的较大者（规则见「实时轨迹」）；计划路线里程只连计划游玩点。`days`：设置了起止日期时按日期，否则取设置的天数与打卡点最大 `day` 中较大者，都没有时按到达时间跨度（见 TripCard）。例外：旅行中且未开启 `live_share` 的旅程，非成员看到的这些字段只按计划计算，见「旅行中的位置隐私」。
- `GET /me/favorites` 只列出当前仍可见（公开且正常，或本人为成员，含旅程所属空间的成员）的旅程。
- `POST /trips/:id/members` 返回更新后的成员列表（同 `GET /trips/:id/members`）；`POST /trips/:id/members/accept` 返回 `TripDetail`。成员列表管理员也可查看。
- 引用路线（fork）复制原旅程中除 `skipped` 和 `verdict=avoid`（踩雷；`include_avoid=true` 时保留）以外的全部打卡点（住宿保持 `kind=lodging` 与所在的晚上），并复制标签、简介、天数与 `travel_mode`；自己引用自己的旅程不计 `fork_count`。`fork_count` 为当前持有该旅程引用副本的其他用户数：同一用户多次引用只计一次，引用副本被删除后相应减少。
- `GET /admin/trips` 额外支持 `?featured=true`。
- **旅行中的位置隐私**：旅程 `phase=ongoing` 且 `live_share=false`（默认）时，非成员（包括游客和持分享码的访客）看到的是「计划本身」：`TripDetail.waypoints` 只含计划内的打卡点，且均为 `status=todo`、`arrived_at=null`、`verdict=""`、`rating=0`；`photos` 为空，`has_track=false`，`visited_count` / `photo_count` 为 0；`GET /trips/:id/track` 返回空 `segments`（`point_count=0`）；`/compare` 同样只按计划返回（`visited` / `extra` 为空，`track_distance_km=0`）；**TripCard 统计同样按计划**：`TripDetail` 以及所有列表中的 TripCard（`GET /trips` 与搜索、`/users/:username/trips`、`/me/favorites`、`/me/invites` 等）里，`waypoint_count` = `planned_count`（只计计划内的点，不含计划外打卡），`visited_count` / `photo_count` 为 0，`distance_km` 为计划路线里程（计划内的点按 `seq` 连线，不用 GPS 轨迹和打卡连线），`cities` / `provinces` 只取计划内的点，`days` 不按到达时间推算（设置了起止日期时按日期，否则取设置的天数与计划内的点（含住宿）最大 `day` 中较大者，否则为 0），`cover_url` / `cover_thumb_url` 未手动设置封面时为空（不使用照片作自动封面），`updated_at` 等于 `created_at`（打卡、照片、轨迹会更新旅程，从而暴露最近活动时间）；`GET /trips` 的 `q` / `city` / `province` 对这类旅程只匹配计划内打卡点的城市和省份；`/places/:id/reviews`、`/users/:username/footprints` 不包含该旅程；引用路线（fork）只复制计划内的打卡点；该旅程的打卡也不计入地点统计、地点封面和踩雷提醒，旅程结束后计入。成员和管理员不受影响；旅程结束（`finished`）后按原可见性全部公开。

### 打卡点 / 按路线出行
- 创建打卡点可额外传 `province` / `city` / `district`（如来自 `/geo/search` 结果）：`district` 优先使用客户端值；`province` / `city` 始终以离线行政区划为准，仅当坐标不在国内时才使用客户端值。
- 计划外且未给 `arrived_at` 的打卡点默认 `arrived_at` = 当前时间；例外：在 `phase=finished` 的旅程中补录时保持为空。
- 实际路线排序：全部已到达点都有 `arrived_at` 时按时间，否则按 `seq`。
- `PATCH /waypoints/:id` 将坐标移动超过 500 米时，若同一请求未提供 `amap_id` / `address`，则清除原 `amap_id`（按名称 + 新位置重新关联 Place），并清空地址后由逆地理编码重新补全（未配置高德 Key 时地址留空）。
- `POST /trips/:id/checkin` 可选传 `arrived_at`；新建的计划外点若设置了旅程开始日期则自动计算 `day`。`POST /waypoints/:id/checkin` 以及带 `waypoint_id` 的 `POST /trips/:id/checkin` 对已到达的点仅在显式传入 `arrived_at` 时更新时间（未传时保留原到达时间）。「我到了」打卡（`/trips/:id/checkin`、`/waypoints/:id/checkin`）与上传轨迹会把 `planning` 旅程自动切换为 `ongoing`。
- 自动建点的照片关联到 300 米内最近的打卡点；若该点是 `todo` 计划点、照片距它不超过 100 米，且旅程不处于 `planning`、照片带拍摄时间，则该计划点被标记为已到达（`arrived_at` = 拍摄时间）。
- `suggestions[]` 中 `source=plan` 的项额外带 `waypoint_id`（可直接调用 `/waypoints/:id/checkin`）。`ai` 参数缺省为 false。
- `POST /ai/plan`：`days` 1–15（缺省 3），`preferences` ≤300 字；AI 调用失败或超时返回 `500 internal`（message 可直接展示）。每天最多安排约 6 个地点（行程越长每天越少，超过 7 天时每天 2–4 个），另加每晚一个住宿，备注简短，以加快生成。
- 自动命名：未给名称的打卡点（「我到了」计划外打卡、照片自动建点、只给坐标新建）在服务端配置了高德或天地图时，优先用所在的区域名称（如位于「甲午岩景区」内），否则用 30 米内最近的地点名称，再否则为「区县·街道」；未配置时为城市名。
- `/trips/:id/recommend` 的 AI 挑选最多等待 20 秒（`TRIPHUB_AI_TIMEOUT` 更短时以其为准），超时自动退回规则推荐。

### 照片 / 存储
- 除照片外，`POST /uploads/image` 的通用图片也计入存储配额（删除旅程/照片时释放对应照片占用）；头像不计入。
- 单张照片的占用 = 处理后原图 + 缩略图的字节数。

### 地点
- `GET /places/:id`：有公开打卡、带 `amap_id`、或被某个公开旅程引用的地点对所有人可见（reviews / comments 同样适用）；其余地点仅对引用了它的旅程成员（含待接受的邀请与旅程所属空间的成员）和管理员可见（避免泄露私密旅程）。
- `TripDetail`（`GET /trips/:id`、`GET /share/:code`、创建 / 修改旅程的响应）中的打卡点在关联地点有公开打卡时带 `place_stats`（字段同 `/geo/search` 结果的 `place`），用于在行程中提示社区的「踩雷」评价；其它接口返回的 Waypoint 不带该字段。
- `GET /places` 的 `q` 同时匹配名称、地址、区县、城市、省份（与 `/trips` 的 `q` 一致）；`city` 参数仅按城市 / 省份筛选。
- `GET /places` 缺省 `sort=hot`；`rating` 只含有评分的地点，`avoid` 只含有踩雷记录的地点。`/places/nearby` 的 `radius` 取值 50–50000，`limit` ≤100，另支持 `category`。
- 地点统计中同一用户对同一地点只计一次（`checkin_count` 为打卡人数，评价、评分、人均取该用户最近一次有值的评价），不计旅行中且未开启实时公开的旅程；服务端升级后首次启动时按此规则重算全部地点（只执行一次）。旅行中的踩雷提醒（`/trips/:id/recommend` 的 `warnings`）和 AI 规划的「请避开」只针对至少 2 人标记踩雷且踩雷多于推荐的地点。

### 评论 / 通知
- 顶层评论按时间倒序、回复按时间正序。直接回复顶层评论时 `reply_to` 为 null；回复某条回复时挂到同一顶层评论下并设置 `reply_to`。已删除的回复不返回。
- 旅程评论（含回复）通知旅程作者（`comment`），回复另通知被回复者（`reply`，同一人只收一条）；地点评论只在被回复时通知。
- 通知中的 `trip` 仅在接收者当前仍可查看该旅程时返回。点赞 / 收藏 / 关注 / 引用通知对同一对象只发送一次。升级时会收到 `system` 通知。
- `POST /notifications/read` 返回 `{updated: n}`。

### 内容安全
- **屏蔽词**（`/admin/settings` 的 `sensitive_words`，缺省为空）：用户提交的旅程标题 / 简介 / 正文 / 标签、评论、打卡点名称 / 地址 / 备注、照片说明、昵称 / 个人简介、注册用户名、空间名称 / 类型名称 / 简介与空间邀请留言中包含屏蔽词时返回 `400`，message 为 `内容包含不允许发布的词语「xx」，请修改后再提交`。匹配时忽略大小写、全角 / 半角、空格、标点与符号（如「博 彩」「博*彩」也会命中）。管理员不受限制。已发布的内容不会被追溯处理，但再次提交修改时会重新检查所提交的字段。
- **公开旅程需审核**（`review_public_trips`，缺省关闭）：开启后，非管理员新建公开旅程或把旅程改为公开时，旅程 `status` 为 `pending`：不出现在广场、搜索与地点统计中，非成员访问返回 404。管理员通过 `PATCH /admin/trips/:id {"status": "normal"}` 审核通过（`published_at` 更新为通过时间），`{"status": "hidden"}` 驳回；两种情况作者都会收到 `system` 通知。待审核的旅程改为非公开时退出审核队列（`status` 恢复为 `normal`）；被隐藏的旅程作者无法自行恢复。已公开的旅程修改内容不需重新审核；关闭审核不会自动通过队列中的旅程。「旅程首次公开」的经验在审核通过时发放。`GET /admin/trips?status=pending` 为审核队列。
- **图片地址**：`cover_url`、`avatar_url` 只接受本站上传得到的 `/uploads/...` 路径（或空字符串），外部链接返回 400；正文 Markdown 中的图片，客户端只显示 `/uploads/` 开头的地址。

### 管理后台
- `GET /admin/reports` 的 `target_preview`：用户为 `@username · 昵称：xxx`，旅程为标题，评论为内容摘要，地点为名称；对象已删除时为 `（已删除）`。
- 管理员不能取消自己的管理员权限或封禁自己；封禁会吊销该用户全部 refresh token。
