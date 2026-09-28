# TripHub 部署指南

TripHub 由一个 Go 服务端（内嵌了网页前端）和一个 PostgreSQL 数据库组成，用 Docker Compose 一条命令就能跑起来。

## 一、准备

- 一台 Linux 服务器（1 核 2G 起步即可），已安装 Docker 与 Docker Compose 插件
  - 安装：`curl -fsSL https://get.docker.com | sh`（国内可加 `-s --mirror Aliyun`）
- 开放端口（云服务器还要在安全组中放行）：8080（或你自定义的端口，仅在不启用 HTTPS 时需要）；启用 HTTPS 时开放 TCP 80 / 443（如需 HTTP/3 再放行 UDP 443，不放行也能正常访问），并按第三节关闭 8080 的公网访问

## 二、部署（使用发布包，推荐）

发布包 `triphub-<版本>.tar.gz` 里已经包含编译好的程序，**不需要在服务器上编译**，也不需要拉取 Node / Go 镜像。

```bash
# 1. 上传并解压（可先用 sha256sum -c triphub-*.tar.gz.sha256 核对文件是否完整）
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

`docker compose ps` 中 app 显示 `(healthy)` 即启动完成（首次启动或升级后可能需要几十秒）；显示 `(unhealthy)` 或反复重启时执行 `docker compose logs app` 查看原因。也可以用 `docker compose up -d --wait` 等待启动完成。

容器日志会自动轮转（每个服务最多保留约 50MB），只看最近的日志：`docker compose logs --tail 200 app`。

浏览器访问 `http://服务器IP:8080`，用 `.env` 里配置的管理员账号登录，右上角头像菜单里有「管理后台」。

> **国内服务器拉不到 postgres 镜像？** 在 `.env` 中设置
> `POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres:16-alpine`（或其它可用的镜像加速地址），再重新执行 `docker compose up -d --build`。
>
> **ARM 服务器（如华为鲲鹏、阿里倚天、树莓派 64 位系统）**：无需额外配置，构建镜像时会自动选用对应架构（amd64 / arm64）的程序。

## 三、启用 HTTPS（强烈建议）

浏览器只有在 **HTTPS** 页面下才允许网页获取定位，所以「实时记录轨迹」「我到了，打卡」「附近推荐」等功能需要 HTTPS。

**方式 A：使用内置 Caddy 自动申请免费证书**

1. 域名解析到服务器 IP（国内服务器的域名需要先完成 ICP 备案）
2. `.env` 中设置 `DOMAIN=你的域名`
3. `.env` 中设置 `HTTP_PORT=127.0.0.1:8080`（Caddy 通过容器内部网络访问应用，8080 无需对公网开放）；之前设置过 `TRUSTED_PROXIES=none` 的改回留空
4. `docker compose --profile https up -d --build`

建议同时取消 `.env` 中 `COMPOSE_PROFILES=https` 这一行的注释：之后执行 `docker compose up -d`、`docker compose down`（包括升级时）都会自动带上 Caddy，不用每次加 `--profile https`。

**方式 B：已有 Nginx**：在 `.env` 中设置 `HTTP_PORT=127.0.0.1:8080`（设置过 `TRUSTED_PROXIES=none` 的改回留空）并执行 `docker compose up -d`，然后参考 `nginx.conf.example` 反向代理到 `127.0.0.1:8080`。

> **启用 HTTPS 后务必关闭 8080 的公网访问**：否则网站仍能通过 `http://服务器IP:8080` 明文访问，登录密码和令牌可能被窃听。设置后执行 `docker compose ps`，应显示 `127.0.0.1:8080->8080/tcp`；并在云服务器安全组中删除 8080 的放行规则。注意：Docker 发布的端口会绕过 ufw / firewalld，仅在 ufw 中关闭 8080 无效。之后请使用 `https://你的域名` 访问（旧的 `http://IP:8080` 书签和分享链接会失效）。
>
> 内置 Caddy 和 `nginx.conf.example` 都开启了 HSTS：浏览器通过 HTTPS 访问过一次后，一年内都只会用 HTTPS 打开这个域名，所以启用后不要再改回 HTTP。

## 四、备案与合规（在中国大陆公开运营必读）

- **ICP 备案**：域名解析到中国大陆的服务器并对外提供访问之前，必须先通过云服务商完成 ICP 备案。拿到备案号后填到「管理后台 → 站点设置 → 备案信息」，网站页脚会显示备案号，并链接到 [beian.miit.gov.cn](https://beian.miit.gov.cn/)。
- **公安联网备案**：网站开通后 30 日内到 [全国互联网安全管理服务平台](https://beian.mps.gov.cn/) 办理，拿到的公安备案号同样填在「站点设置 → 备案信息」中。
- **用户协议 / 隐私政策**：在「站点设置」中编辑；留空时使用内置模板，但至少要把模板里的【运营者名称】【联系邮箱】换成你自己的信息。用户注册时必须勾选同意。
- **内容安全**：开放注册的公开网站负有实名与内容审核义务。建议在「站点设置」中配置屏蔽词、开启「公开旅程需审核」（在「内容管理 → 待审核」中通过），或关闭开放注册；用户的举报在「举报处理」中处理。

## 五、高德 Key（强烈建议配置）

不配置也能用：底图正常显示，可以在地图上点选地点，省/市会自动识别。
配置后可以 **搜索具体店铺/景点、识别街道级地址、推荐附近地点、校正 AI 规划的地点坐标**。
还会用于 **路径规划**：路线编辑中显示相邻两站之间步行 / 公交地铁 / 驾车的用时。结果缓存 7 天，与搜索等功能消耗同一份高德调用额度；未配置 Key 时按直线距离估算用时。

1. 注册 [高德开放平台](https://lbs.amap.com/)，完成开发者认证
2. 控制台 → 应用管理 → 创建应用 → 添加 Key，**服务平台选择「Web服务」**（不是「Web端(JS API)」，也不是 Android / iOS / 小程序；服务器上调用的只能是「Web服务」Key，否则所有请求都会被高德拒绝）
3. 如果给 Key 设置了 IP 白名单，要填服务器的**公网出口 IP**（不设白名单也可以）
4. 把 Key 填到 `.env` 的 `AMAP_KEY=`，然后 `docker compose up -d`
5. 用管理员账号打开「管理后台」，查看**服务诊断**（接口 `GET /api/v1/admin/diagnostics`）：「高德」一项显示「正常」即配置成功

搜索框会同时查询高德的关键字搜索和输入提示并合并结果，民宿、小店这类只出现在输入提示里的地点也能搜到。

**配置了 Key 却搜不到具体店铺 / 民宿？** 多半是 Key 本身有问题：高德拒绝请求时，服务端会退回到只能搜省市名称的离线搜索（配置了天地图时退回天地图），同时暂停调用高德 10 分钟，并在搜索结果中带上原因（`amap_error`，网页上会显示给你）。服务诊断里会直接显示原因，常见的有：

| 诊断信息 | 高德错误码 | 处理 |
|---|---|---|
| 高德 Key 的服务平台不是「Web服务」 | 10009 USERKEY_PLAT_NOMATCH | 在高德控制台为本站**新建**一个服务平台为「Web服务」的 Key，替换 `.env` 里的 `AMAP_KEY` |
| 高德 Key 无效，请检查 .env 中的 AMAP_KEY | 10001 INVALID_USER_KEY | Key 复制错了（多了空格 / 少了字符）或已删除 |
| 服务器 IP 不在高德 Key 的白名单中 | 10005 INVALID_USER_IP | 在高德控制台把服务器的公网 IP 加入白名单，或清空白名单 |
| 高德调用额度已用完 | 10003 / 10044 / 10041 | 当日免费额度用完，次日恢复；或在高德控制台提升额度 |
| 该 Key 没有此接口权限 | 10012 INSUFFICIENT_PRIVILEGES | 在高德控制台确认该 Key 开通了搜索、逆地理编码、输入提示、路径规划等 Web 服务 |
| 服务器无法连接高德（restapi.amap.com） | – | 服务器不能访问外网，检查防火墙 / 出站规则 / DNS |

修改 `.env` 后执行 `docker compose up -d` 使其生效，再在服务诊断里确认。

### 天地图（可选，免费的地点搜索备用）

[天地图](https://www.tianditu.gov.cn/) 是国家地理信息公共服务平台，个人注册即可免费申请 Key。配置后：没有高德 Key、高德调用失败（Key 错误、额度用完）或高德搜不到时，地点搜索改用天地图；地图点选位置、打卡点自动命名在高德不可用时也会用天地图识别附近地点和地址。天地图的数据比高德少，建议作为高德的补充，而不是替代。

1. 打开 [天地图控制台](https://console.tianditu.gov.cn/) 注册并登录（需要手机号验证）
2. 「应用管理」→「创建新应用」，应用名称按「应用名称-应用场景」填写（如「TripHub-旅行地图」，信息不完整的应用可能被限流），**应用类型选择「服务端」**（浏览器端 Key 在服务器上调用会报「权限类型错误」）；如填写 IP 白名单，填服务器的公网出口 IP
3. 复制生成的 Key，填到 `.env` 的 `TIANDITU_KEY=`，然后 `docker compose up -d`
4. 在「管理后台 → 服务诊断」中确认「天地图」一项显示「正常」

天地图的坐标（CGCS2000，与 WGS-84 基本一致）由服务端自动转换为网站统一使用的 GCJ-02。天地图的接口格式按其公开文档实现；如果服务诊断显示正常但搜索结果不理想，可以只把它当作高德的备用。

## 六、AI 推荐与 AI 规划（可选）

支持任意 **OpenAI 兼容接口**，云端 API 或本地模型都可以。在 `.env` 中配置：

| 服务 | AI_BASE_URL | AI_MODEL |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`（快，推荐）或 `deepseek-v4-pro` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://host.docker.internal:11434/v1` | 如 `qwen2.5:7b`（`AI_API_KEY` 留空，见下方说明） |

`AI_BASE_URL` 填服务商文档里的 base URL 即可：带不带 `/v1`、末尾有没有 `/`、甚至直接填完整的 `…/chat/completions` 地址都可以。

配置后，前端会出现「AI 帮我规划」，旅行中的「推荐下一站」也会由 AI 结合位置、时间和社区评价给出理由。
未配置时，推荐功能会自动使用规则推荐（计划中的下一站 + 附近社区高分地点 + 避雷提醒）。
配置完成后在「管理后台 → 服务诊断」查看「AI」一项：会实际向模型发一条消息，显示是否正常、用时，失败时给出原因（Key 无效、余额不足、模型不存在、超时、连不上等）。

### 深度思考与超时

DeepSeek 等模型**默认开启深度思考**：先输出很长的思考过程再给答案，生成一份多日行程可能要好几分钟，容易超时。TripHub 默认关闭深度思考（`AI_THINKING=off`）：

- DeepSeek（地址含 `deepseek`）：请求中带 `"thinking": {"type": "disabled"}`
- 阿里云百炼 / 通义千问（地址含 `dashscope` 或 `aliyuncs`）：请求中带 `"enable_thinking": false`
- 其他服务商不额外传参数；需要时用 `AI_EXTRA_BODY` 传入该服务商的参数（一个 JSON 对象，会合并到每次请求中并覆盖上面的设置），例如 `AI_EXTRA_BODY={"reasoning_effort":"low"}`

想要更深入的规划可设 `AI_THINKING=on`，或 `low` / `high` / `max`（DeepSeek 的思考强度 `reasoning_effort`），同时把 `AI_TIMEOUT` 调大（如 `300s`）。服务商不认识这些参数（返回 400 且提到未知参数）时，服务端会自动去掉它们重试一次。

`AI_TIMEOUT` 缺省 120 秒，是一次 AI 规划最长等待的时间；旅行中的「推荐下一站」最多等 20 秒，超时自动改用规则推荐。网页端的「AI 帮我规划」使用流式接口，会实时显示「正在思考 / 正在生成（已生成 N 字）/ 正在核对地点」的进度。流式响应带有 `X-Accel-Buffering: no` 并且每 10 秒发送一次心跳，**内置 Caddy 和按 `nginx.conf.example` 配置的 Nginx 都不需要额外设置**；自己的 Nginx 只需保证 `proxy_read_timeout` 大于 `AI_TIMEOUT`（示例为 600s）。

### 使用本机 Ollama

- Ollama 默认只监听 `127.0.0.1`，容器通过 `host.docker.internal` 访问会被拒绝（`docker compose logs app` 中出现 `connection refused`）。需要让它监听所有网卡：

  ```bash
  sudo systemctl edit ollama
  # 在打开的编辑器中加入下面两行并保存：
  #   [Service]
  #   Environment="OLLAMA_HOST=0.0.0.0:11434"
  sudo systemctl daemon-reload && sudo systemctl restart ollama
  ```

- **安全提示**：Ollama 没有鉴权，不要在云服务器安全组或防火墙中对公网开放 11434。启用了 ufw 时只放行 Docker 网段：`sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp`。
- 只有 CPU 时，7B 模型生成多日行程通常需要几分钟：在 `.env` 设置 `AI_TIMEOUT=300s` 后执行 `docker compose up -d`；使用 Nginx 时 `proxy_read_timeout` 要大于该值。有显卡或使用云端 API 会快很多。7B 模型约需 6GB 以上内存。
- 模型在另一台机器上时，`AI_BASE_URL` 填 `http://该机器IP:11434/v1`。

## 七、数据与备份

所有数据都在部署目录的 `data/` 下：

- `data/postgres/`：数据库
- `data/app/uploads/`：用户上传的照片
- `data/app/jwt_secret`：登录签名密钥（自动生成）

备份示例：

```bash
# 备份（网站运行时即可执行）
docker compose exec -T db pg_dump -U triphub --clean --if-exists triphub | gzip > backup-$(date +%F).sql.gz
tar czf files-$(date +%F).tar.gz .env data/app   # 照片 + 登录密钥 + 配置（.env 含密码和各类 Key，请妥善保管）
```

每天自动备份数据库（可选）：执行 `crontab -e` 加入下面一行，每天 4 点备份、保留最近 14 天。把 `/opt/triphub` 换成你的部署目录（升级换了目录后要同步修改）；crontab 里的 `%` 必须写成 `\%`。

```
0 4 * * * cd /opt/triphub && mkdir -p backups && docker compose exec -T db pg_dump -U triphub --clean --if-exists triphub | gzip > backups/db-$(date +\%F).sql.gz && find backups -name 'db-*.sql.gz' -mtime +14 -delete
```

### 恢复（迁移到新服务器 / 灾难恢复）

```bash
# 1. 解压发布包后，在部署目录还原 .env 和 data/app
tar xzf files-2026-09-24.tar.gz
# 2. 只启动数据库，先不要启动 app（app 首次启动会建空表并创建管理员，导入会和备份冲突，导致所有用户丢失）
docker compose up -d --wait db
# 3. 导入：出错会立即停止并整体回滚，不会只导入一半
gunzip -c backup-2026-09-24.sql.gz | docker compose exec -T db psql -U triphub -d triphub -v ON_ERROR_STOP=1 --single-transaction
# 4. 启动全部服务
docker compose up -d --build
```

- 导入命令必须没有 `ERROR` 且正常结束。
- 如果已经执行过 `docker compose up -d`（app 启动过），先执行 `docker compose stop app` 再导入：带 `--clean --if-exists` 的备份可以直接覆盖；旧备份（没有 `--clean`）要先清空数据库：`docker compose exec -T db dropdb -U triphub --force triphub && docker compose exec -T db createdb -U triphub triphub`，再执行第 3、4 步。
- 数据库密码只在第一次启动时按 `.env` 的 `DB_PASSWORD` 设置。如果 `data/postgres` 是用另一个 `.env` 初始化的（例如在新服务器上先部署、后还原了旧的 `.env`），app 会报 `password authentication failed`，按「常见问题」中的「修改数据库密码」处理。
- 恢复后管理员密码是备份里的密码，`.env` 里的 `ADMIN_PASSWORD` 不会覆盖已有账号。

## 八、升级

> **不要在网站运行时复制 `data/` 目录**：复制正在运行的数据库目录可能得到损坏的数据库，而且复制之后新产生的游记、打卡和照片会丢失。务必先备份、再停止旧版本。

下面的 `docker compose` 命令在启用了 HTTPS 时要加 `--profile https`（`.env` 中设置了 `COMPOSE_PROFILES=https` 的不用加）。

```bash
# 1. 在旧版本目录中备份（网站运行时即可执行）
cd triphub-旧版本
docker compose exec -T db pg_dump -U triphub --clean --if-exists triphub | gzip > ../triphub-pre-upgrade-$(date +%F).sql.gz

# 2. 停止旧版本
docker compose down

# 3. 解压新版本发布包，把 .env 和 data/ 移过去（同一块磁盘上 mv 瞬间完成）
cd .. && tar xzf triphub-新版本.tar.gz
mv triphub-旧版本/.env triphub-旧版本/data triphub-新版本/

# 4. 启动新版本，数据库结构会自动迁移
cd triphub-新版本 && docker compose up -d --build && docker compose logs -f app
```

- 第 1 步的备份命令要等它执行完（回到命令提示符）再进行第 2 步；备份过程中不要停止或重启服务，否则备份不完整。
- 从较早的版本升级时，第一次启动会一次性转换部分数值列（日志出现 `converting numeric columns to double precision`，约每 6 万段旅程 1–2 秒），并重新统计一次地点数据；等 `docker compose ps` 中 app 显示 `(healthy)` 后再访问。

想让旧目录保留一份完整数据用于回滚，第 3 步可以把 `mv` 换成 `cp -a`：必须在第 2 步停止之后执行，要用 root 执行（保留数据库文件的属主），并且磁盘要有同样大小的空闲空间。

**回滚**：在新版本目录执行 `docker compose down`，把 `.env` 和 `data/` 移回旧版本目录，再在旧目录执行 `docker compose up -d --build`（第 3 步用了 `cp -a` 的话，旧目录里保留着升级前的数据，也可以直接启动，但升级后新产生的数据不在里面）。如果旧版本无法使用升级后的数据库，在旧目录用第 1 步的备份恢复到升级前的状态（升级后新产生的数据会丢失）：

```bash
docker compose stop app
docker compose up -d --wait db
docker compose exec -T db dropdb -U triphub --force triphub
docker compose exec -T db createdb -U triphub triphub
gunzip -c ../triphub-pre-upgrade-日期.sql.gz | docker compose exec -T db psql -U triphub -d triphub -v ON_ERROR_STOP=1 --single-transaction
docker compose up -d --build
```

## 九、不用 Docker 直接运行

发布包里的 `triphub-linux-amd64` 是单个静态可执行文件（ARM 服务器用 `triphub-linux-arm64`）：

```bash
export TRIPHUB_DB_DSN='postgres://用户@127.0.0.1:5432/triphub?sslmode=disable'
export PGPASSWORD='数据库密码'   # 单独传密码，含 / # ? % 空格 等特殊字符也没问题
export TRIPHUB_DATA_DIR=/var/lib/triphub
export TRIPHUB_ADMIN_USERNAME=admin TRIPHUB_ADMIN_PASSWORD=你的密码
./triphub-linux-amd64
```

如果把密码直接写在连接串里（`postgres://用户:密码@…`），其中的特殊字符要做 URL 编码（如 `#` → `%23`、`/` → `%2F`）。

可自行配置为 systemd 服务。全部环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TRIPHUB_ADDR` | `:8080` | 监听地址 |
| `TRIPHUB_DB_DSN` | `postgres://triphub:triphub@localhost:5432/triphub?sslmode=disable` | PostgreSQL 连接串（表结构自动迁移）；连接串里没写的部分（如密码）从 `PGPASSWORD` 等标准变量读取 |
| `TRIPHUB_DATA_DIR` | `./data` | 照片（`uploads/`）和 `jwt_secret` 的存放目录 |
| `TRIPHUB_JWT_SECRET` | 自动生成 | 登录签名密钥，留空时自动生成并保存为数据目录下的 `jwt_secret`；自己设置时至少 32 个字符 |
| `TRIPHUB_ADMIN_USERNAME` / `TRIPHUB_ADMIN_PASSWORD` | – | 管理员账号：用户名不存在时创建（密码 8–64 位），不会修改已有账号的密码 |
| `TRIPHUB_AMAP_KEY` | – | 高德 Web 服务 Key（见第五节） |
| `TRIPHUB_TIANDITU_KEY` | – | 天地图「服务端」Key（可选，免费的地点搜索 / 逆地理编码备用，见第五节） |
| `TRIPHUB_CORS_ORIGINS` | – | 允许跨域的来源，逗号分隔（`*` 表示任意）；留空只允许同源 |
| `TRIPHUB_TRUSTED_PROXIES` | 本机和内网地址 | 可信反向代理的 IP / 网段（逗号分隔），只采信它们传来的 `X-Forwarded-For` / `X-Real-IP`；`none` 表示都不信任（不用反向代理、直接开放应用端口时建议设为 `none`） |
| `TRIPHUB_MAX_UPLOAD_MB` | `20` | 单张照片最大 MB |
| `TRIPHUB_SITE_NAME` | `TripHub` | 站点名称初始值（后台「站点设置」保存过之后以后台为准） |
| `TRIPHUB_TILES_NORMAL` / `TRIPHUB_TILES_SATELLITE` / `TRIPHUB_TILES_SATELLITE_LABEL` | 高德瓦片 | 自定义底图瓦片 URL 模板，逗号分隔，必须是 GCJ-02 坐标系 |
| `TRIPHUB_TILES_ATTRIBUTION` | `© 高德地图` | 地图右下角显示的底图版权 / 审图号（可含 HTML），换用其他瓦片时填写对应的版权与审图号 |
| `TRIPHUB_AI_BASE_URL` / `TRIPHUB_AI_API_KEY` / `TRIPHUB_AI_MODEL` | – | OpenAI 兼容接口（见第六节），填了地址和模型才启用 AI |
| `TRIPHUB_AI_TIMEOUT` | `120s` | AI 规划的超时（`90s`、`5m` 这样的时长或秒数）；「推荐下一站」最多等 20 秒 |
| `TRIPHUB_AI_THINKING` | `off` | 深度思考：`off`（关闭，快）/ `on` / `low` / `high` / `max`（后三者为 DeepSeek 的思考强度），见第六节 |
| `TRIPHUB_AI_EXTRA_BODY` | – | 合并到每次 AI 请求中的 JSON 对象（服务商特有参数，覆盖 `TRIPHUB_AI_THINKING` 的设置），如 `{"enable_thinking": false}` |
| `GOMEMLIMIT` | 不限（Docker Compose 部署为 `800MiB`） | 程序的内存软上限（如 `800MiB`、`1500MiB`，单位须写 `MiB` / `GiB`），避免与同一台服务器上的 PostgreSQL 抢内存；处理大照片时仍可能临时超过 |

用 Docker Compose 部署时，在 `.env` 中写去掉 `TRIPHUB_` 前缀的同名变量即可（如 `AMAP_KEY`、`TRUSTED_PROXIES`，对应关系见 `docker-compose.yml`；`GOMEMLIMIT` 同名）；`TRIPHUB_DB_DSN`、`TRIPHUB_DATA_DIR` 已由 `docker-compose.yml` 设置好（数据库密码填 `DB_PASSWORD`），只有 `TRIPHUB_ADDR` 不通过 `.env` 传入。

## 十、从源码构建

```bash
# 需要 Node.js 22.12+（或 20.19+）与 Go 1.27+（请使用最新补丁版本，旧版 Go 标准库有已知安全漏洞）
scripts/build-release.sh v1.0.0      # 产物在 dist/ 下
# 或者直接用 Docker 构建镜像（需要能访问 Docker Hub / npm / Go 代理）
docker build -t triphub .
```

### 用 Docker Compose 从源码部署

没有发布包时，也可以直接在服务器上用源码仓库部署（服务器上只需要 Docker）：

```bash
git clone <仓库地址> triphub && cd triphub/deploy
cp .env.example .env && vim .env   # 同第二节，另外取消 COMPOSE_FILE=docker-compose.yml:docker-compose.source.yml 这一行的注释
docker compose up -d --build       # 在服务器上编译前端和后端，自动按服务器架构编译
```

之后本指南的其它命令都在 `deploy/` 目录下照常使用，数据保存在 `deploy/data/`。升级时先按第七节备份，再执行 `git pull && docker compose up -d --build`。国内服务器可在 `.env` 中设置 `NODE_IMAGE` / `GO_IMAGE` / `NPM_REGISTRY` / `GOPROXY` 使用镜像加速（示例见 `.env.example`）。

> 手动 `docker run` 运行镜像时，务必挂载数据目录（如 `-v /srv/triphub:/data`）并设置 `TRIPHUB_DB_DSN`，否则照片和 `jwt_secret` 会写进匿名卷，重建容器后就找不到了。

## 常见问题

- **搜索不到具体店铺 / 民宿 / 酒店**：到「管理后台 → 服务诊断」查看高德一项的原因，最常见的是 Key 的服务平台不是「Web服务」，见第五节的表格。
- **AI 规划超时 / 很慢**：服务诊断中查看 AI 的用时；确认 `AI_THINKING` 为 `off`（缺省），换用更快的模型（如 DeepSeek 的 `deepseek-flash`），或调大 `AI_TIMEOUT`。
- **地图空白 / 只显示省界轮廓**：浏览器访问不到高德瓦片服务器（`webrd0x.is.autonavi.com`），检查网络；页面会自动退回到内置的省界底图。
- **定位失败**：确认是 HTTPS 访问，并在手机浏览器 / 微信中允许定位权限。
- **iPhone 上传的照片没有位置**：在系统相册选择照片时点「选项」打开「位置」；或者在微信外用 Safari 打开网站。
- **忘记管理员密码**：修改 `.env` 中的 `ADMIN_PASSWORD` 不会覆盖已有账号的密码。在部署目录执行 `docker compose exec app /triphub reset-password -user 管理员用户名`，会重置为随机密码并显示出来（也可以加 `-password '新密码'` 自己指定），该账号在所有设备上的登录随之失效，登录后可在「账号设置」中改成自己的密码。
- **app 启动后立即退出或反复重启**：执行 `docker compose logs app` 查看原因。常见原因：`.env` 中的 `ADMIN_PASSWORD` 仍是示例值或不足 8 位；`JWT_SECRET` 填了但不足 32 个字符（留空会自动生成）；`GOMEMLIMIT` 单位写错（日志出现 `malformed GOMEMLIMIT`，应写成 `800MiB`、`1500MiB` 这样）。
- **普通用户忘记密码**：管理员在「管理后台 → 用户管理」中对该用户执行「重置密码」，会生成一个新密码（转告用户，用户登录后可在「账号设置」中修改），该用户在所有设备上的登录随之失效。
- **修改 `.env` 后没生效**：要执行 `docker compose up -d` 重新创建容器；`docker compose restart` 不会重新读取 `.env`。
- **修改数据库密码**：`DB_PASSWORD` 只在第一次启动（`data/postgres` 为空）时用来初始化数据库，之后直接改 `.env` 会导致 app 日志出现 `password authentication failed`。正确做法：先执行 `docker compose exec db psql -U triphub -d triphub -c "ALTER USER triphub PASSWORD '新密码'"`，再把 `.env` 的 `DB_PASSWORD` 改成同一个值，然后 `docker compose up -d`。（首次部署、还没有任何数据时，也可以 `docker compose down && rm -rf data/postgres` 后重新启动。）
- **HTTPS 没生效**：Caddy 要等 app 显示 `(healthy)` 后才启动，先用 `docker compose ps` 确认 app 正常；再执行 `docker compose logs caddy` 查看原因（常见：`.env` 未设置 `DOMAIN`、域名未解析到本机、80/443 端口被占用或安全组未放行、国内服务器域名未备案）。
