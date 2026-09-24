# TripHub · 旅行足迹

面向年轻人、情侣和旅行博主的旅行记录与分享社区：**规划路线 → 按图出行 → 打卡评价 → 对比回顾 → 分享避雷**。

## 功能

**路线规划与出行**
- 规划路线：搜索店铺、景点或街道（高德 POI），也可以直接在地图上点选。支持按天分组、拖拽排序，拖动地图上的标记可以微调位置
- AI 帮我规划：填写目的地、天数和偏好，自动生成逐日行程，坐标由高德校正
- 旅行模式：显示下一站和剩余距离；到了一个地方可以一键打卡（优先匹配计划点，否则记为计划外）；可以实时记录 GPS 轨迹（离线缓冲，屏幕常亮）；支持拍照打卡
- 推荐下一站：计划中的下一站、附近社区高分地点、高德周边，再由 AI 结合时间和位置挑选并说明理由；附近被多人踩雷的地点会给出**避雷提醒**
- 计划 vs 实际：完成度、跳过的点、计划外的新发现、里程和时间偏差、每天的执行情况

**记录与分享**
- 打卡点精确到店铺和街道，每个点可以标记**推荐 / 一般 / 踩雷**，填写评分、人均消费和避坑备注
- 从照片生成足迹：读取照片里的 EXIF 定位和拍摄时间，自动生成打卡点（支持 HEIC，300 米内的照片会合并到同一个点）
- 地点聚合：同一家店的所有公开打卡汇总到一个页面，显示推荐率、踩雷数和大家的评价，另有热门榜和避雷榜
- 可见范围分为私密、链接可见、公开。分享支持二维码和系统分享
- 一键引用路线：把别人的路线复制成自己的计划
- 社区功能：点赞、收藏、评论（可以针对某个打卡点）、关注、通知
- 导航：可以唤起高德、百度、腾讯或 Apple 地图 App，也可以跳转网页地图，支持整条路线导航

**3D 与「我们一起走过的地方」**
- 3D 旅程回放：夜景底图上动画绘制轨迹，镜头跟随路线，到达的打卡点会升起光柱，并显示照片和评价卡片；支持计划与实际的对比回放
- 点亮中国：去过的省份在 3D 地图上按打卡数量升高，城市显示为光柱，旅程之间用弧线相连
- 足迹地球：3D 球面上显示全部足迹，地球会自动旋转
- 情侣空间：绑定后可以设置纪念日，显示「在一起 N 天」，汇总两人共同的足迹并提供 3D 回放

**用户体系**
- 游客、用户（Lv1–Lv6，按经验值升级，等级越高存储空间越大）、管理员
- 管理后台：数据概览、用户管理（封禁、角色、经验值）、内容管理（精选、隐藏、删除）、评论管理、举报处理、站点设置和公告

## 技术架构

```
┌──────────────┐   REST /api/v1   ┌────────────────────┐    ┌────────────┐
│ Web (React)  │ ───────────────▶ │  Go 服务端 (Gin)   │ ─▶ │ PostgreSQL │
│ 未来 App      │                  │  内嵌前端静态文件    │    └────────────┘
└──────────────┘                  │  高德 Web 服务 / AI │
                                  └────────────────────┘
```

- **数据与展示分离**：所有核心数据都在服务端，网页只负责展示。以后的 App 直接复用同一套 API，见 [docs/API.md](docs/API.md)
- **后端**：Go 1.27、Gin、GORM、PostgreSQL、JWT（access + refresh token）。图片压缩和缩略图生成、EXIF 解析、坐标转换（WGS-84 ⇄ GCJ-02）、离线省市识别（内置行政区边界）、高德 Web 服务和 OpenAI 兼容 AI 客户端都在服务端完成
- **前端**：React 19、TypeScript、Vite、Tailwind CSS 4、TanStack Query。地图用 MapLibre GL 叠加高德瓦片，3D 效果用 deck.gl
- **部署**：前端打包进 Go 二进制，运行镜像基于 `scratch`（约 26MB，压缩后约 9MB），用 Docker Compose 一键启动

## 目录

```
server/          Go 服务端（API、业务、存储）
web/             React 网页前端
docs/API.md      API 文档（网页与 App 共用）
docs/DEPLOY.md   部署指南
deploy/          docker-compose、Caddy / Nginx 配置
scripts/         构建发布包脚本
```

## 本地开发

```bash
# 数据库
docker run -d --name triphub-pg -p 5432:5432 \
  -e POSTGRES_USER=triphub -e POSTGRES_PASSWORD=triphub -e POSTGRES_DB=triphub postgres:16-alpine

# 后端（http://localhost:8080）
cd server && TRIPHUB_ADMIN_USERNAME=admin TRIPHUB_ADMIN_PASSWORD=admin123 go run ./cmd/triphub

# 前端（http://localhost:5173，/api 自动代理到 8080）
cd web && npm install && npm run dev
```

测试：`cd server && go test ./...`（设置 `TRIPHUB_TEST_DSN` 后会运行数据库集成测试）；`cd web && npm run build`。

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)。简要步骤：

```bash
scripts/build-release.sh v1.0.0          # 生成 dist/triphub-v1.0.0.tar.gz
# 上传到服务器后：
tar xzf triphub-v1.0.0.tar.gz && cd triphub-v1.0.0
cp .env.example .env && vim .env
docker compose up -d --build
```
