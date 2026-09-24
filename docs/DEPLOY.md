# TripHub 部署指南

TripHub 由一个 Go 服务端（内嵌了网页前端）和一个 PostgreSQL 数据库组成，用 Docker Compose 一条命令就能跑起来。

## 一、准备

- 一台 Linux 服务器（1 核 2G 起步即可），已安装 Docker 与 Docker Compose 插件
  - 安装：`curl -fsSL https://get.docker.com | sh`（国内可加 `-s --mirror Aliyun`）
- 开放端口：8080（或你自定义的端口）；启用 HTTPS 时需开放 80 / 443

## 二、部署（使用发布包，推荐）

发布包 `triphub-<版本>.tar.gz` 里已经包含编译好的程序，**不需要在服务器上编译**，也不需要拉取 Node / Go 镜像。

```bash
# 1. 上传并解压
tar xzf triphub-*.tar.gz && cd triphub-*/

# 2. 配置
cp .env.example .env
vim .env          # 至少修改 DB_PASSWORD、ADMIN_USERNAME、ADMIN_PASSWORD

# 3. 启动
docker compose up -d --build

# 4. 查看状态 / 日志
docker compose ps
docker compose logs -f app
```

浏览器访问 `http://服务器IP:8080`，用 `.env` 里配置的管理员账号登录，右上角头像菜单里有「管理后台」。

> **国内服务器拉不到 postgres 镜像？** 在 `.env` 中设置
> `POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine`（或其它可用的镜像加速地址），再重新执行 `docker compose up -d --build`。
>
> **ARM 服务器（如部分国产云 / 树莓派）**：在 `.env` 中设置 `ARCH=arm64`。

## 三、启用 HTTPS（强烈建议）

浏览器只有在 **HTTPS** 页面下才允许网页获取定位，所以「实时记录轨迹」「我到了，打卡」「附近推荐」等功能需要 HTTPS。

**方式 A：使用内置 Caddy 自动申请免费证书**

1. 域名解析到服务器 IP（国内服务器的域名需要先完成 ICP 备案）
2. `.env` 中设置 `DOMAIN=你的域名`
3. `docker compose --profile https up -d --build`

**方式 B：已有 Nginx**：参考 `nginx.conf.example` 反向代理到 `127.0.0.1:8080`。

## 四、高德 Key（强烈建议配置）

不配置也能用：底图正常显示，可以在地图上点选地点，省/市会自动识别。
配置后可以 **搜索具体店铺/景点、识别街道级地址、推荐附近地点、校正 AI 规划的地点坐标**。

1. 注册 [高德开放平台](https://lbs.amap.com/)，完成开发者认证
2. 控制台 → 应用管理 → 创建应用 → 添加 Key，**服务平台选择「Web服务」**
3. 把 Key 填到 `.env` 的 `AMAP_KEY=`，然后 `docker compose up -d`

## 五、AI 推荐与 AI 规划（可选）

支持任意 **OpenAI 兼容接口**，云端 API 或本地模型都可以。在 `.env` 中配置：

| 服务 | AI_BASE_URL | AI_MODEL |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://host.docker.internal:11434/v1` | 如 `qwen2.5:7b`（`AI_API_KEY` 留空） |

配置后，前端会出现「AI 帮我规划」，旅行中的「推荐下一站」也会由 AI 结合位置、时间和社区评价给出理由。
未配置时，推荐功能会自动使用规则推荐（计划中的下一站 + 附近社区高分地点 + 避雷提醒）。

## 六、数据与备份

所有数据都在部署目录的 `data/` 下：

- `data/postgres/`：数据库
- `data/app/uploads/`：用户上传的照片
- `data/app/jwt_secret`：登录签名密钥（自动生成）

备份示例：

```bash
docker compose exec db pg_dump -U triphub triphub | gzip > backup-$(date +%F).sql.gz
tar czf uploads-$(date +%F).tar.gz data/app/uploads
```

## 七、升级

解压新版本发布包，把旧目录里的 `.env` 和 `data/` 复制（或移动）过去，然后执行 `docker compose up -d --build`。数据库结构会在启动时自动迁移。

## 八、不用 Docker 直接运行

发布包里的 `triphub-linux-amd64` 是单个静态可执行文件：

```bash
export TRIPHUB_DB_DSN='postgres://用户:密码@127.0.0.1:5432/triphub?sslmode=disable'
export TRIPHUB_DATA_DIR=/var/lib/triphub
export TRIPHUB_ADMIN_USERNAME=admin TRIPHUB_ADMIN_PASSWORD=你的密码
./triphub-linux-amd64
```

可自行配置为 systemd 服务。全部环境变量见仓库 `server/README.md`。

## 九、从源码构建

```bash
# 需要 Node.js 20+ 与 Go 1.24+
scripts/build-release.sh v1.0.0      # 产物在 dist/ 下
# 或者直接用 Docker 构建镜像（需要能访问 Docker Hub / npm / Go 代理）
docker build -t triphub .
```

## 常见问题

- **地图空白 / 只显示省界轮廓**：浏览器访问不到高德瓦片服务器（`webrd0x.is.autonavi.com`），检查网络；页面会自动退回到内置的省界底图。
- **定位失败**：确认是 HTTPS 访问，并在手机浏览器 / 微信中允许定位权限。
- **iPhone 上传的照片没有位置**：在系统相册选择照片时点「选项」打开「位置」；或者在微信外用 Safari 打开网站。
- **忘记管理员密码**：修改 `.env` 中的 `ADMIN_PASSWORD` 不会覆盖已有账号；可以新建一个管理员用户名（修改 `ADMIN_USERNAME`）重启后登录，再到后台处理。
