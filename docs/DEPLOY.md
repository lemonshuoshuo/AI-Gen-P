# TripHub 部署指南

TripHub 由一个 Go 服务端（内嵌了网页前端）和一个 PostgreSQL 数据库组成，用 Docker Compose 一条命令就能跑起来。

## 一、准备

- 一台 Linux 服务器（1 核 2G 起步即可），已安装 Docker 与 Docker Compose 插件
  - 安装：`curl -fsSL https://get.docker.com | sh`（国内可加 `-s --mirror Aliyun`）
- 开放端口（云服务器还要在安全组中放行）：8080（或你自定义的端口，仅在不启用 HTTPS 时需要）；启用 HTTPS 时开放 TCP 80 / 443（如需 HTTP/3 再放行 UDP 443，不放行也能正常访问），并按第三节关闭 8080 的公网访问

## 二、部署（使用发布包，推荐）

发布包 `triphub-<版本>.tar.gz` 里已经包含编译好的程序，**不需要在服务器上编译**，也不需要拉取 Node / Go 镜像。
包里的文件直接解压在当前目录（没有版本号目录）：选定一个部署目录（下文以 `/root/triphub` 为例），以后升级也一直在这个目录里进行（见第八节）。

> **已经在运行 v1.2.1 及更早的版本**（部署目录名带版本号，如 `triphub-v1.2.0/`）？不要按本节重新部署（网站会换成一个空数据库），按第八节「从旧的目录结构迁移」操作。

```bash
# 1. 建部署目录，把发布包上传到这里，然后解压（可先用 sha256sum -c triphub-*.tar.gz.sha256 核对文件是否完整）
mkdir -p /root/triphub && cd /root/triphub
tar xzf triphub-v*.tar.gz

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
5. 用管理员账号打开「管理后台」，查看**系统诊断**（接口 `GET /api/v1/admin/diagnostics`）：「高德」一项显示「正常」即配置成功

搜索框会同时查询高德的关键字搜索和输入提示并合并结果，民宿、小店这类只出现在输入提示里的地点也能搜到。

**配置了 Key 却搜不到具体店铺 / 民宿？** 高德拒绝请求时，服务端会退回到只能搜省市名称的离线搜索（配置了天地图时退回天地图），并在搜索结果中带上原因（`amap_error`，网页上会显示给你）。Key 或额度的错误会暂停调用高德 10 分钟；网络故障（单次请求最长等 10 秒）要在不同时刻**连续 3 次**才暂停 20 秒（同一次搜索并发的两个请求只算一次），偶尔一次超时不会影响其他人。系统诊断里会直接显示原因，常见的有：

| 诊断信息 | 高德错误码 | 处理 |
|---|---|---|
| 高德 Key 的服务平台不是「Web服务」 | 10009 USERKEY_PLAT_NOMATCH | 在高德控制台为本站**新建**一个服务平台为「Web服务」的 Key，替换 `.env` 里的 `AMAP_KEY` |
| 高德 Key 无效 | 10001 INVALID_USER_KEY | Key 复制错了（多了空格 / 少了字符）或已删除；对照系统诊断「技术细节」里 Key 的长度和首尾字符 |
| 服务器 IP 不在高德 Key 的白名单中 | 10005 INVALID_USER_IP | 在高德控制台把服务器的公网 IP 加入白名单，或清空白名单 |
| 高德调用额度已用完 | 10003 / 10044 / 10041 | 当日免费额度用完，次日恢复；或在高德控制台提升额度 |
| 该 Key 没有此接口权限 | 10012 INSUFFICIENT_PRIVILEGES | 在高德控制台确认该 Key 开通了搜索、逆地理编码、输入提示、路径规划等 Web 服务 |
| 高德 Key 开启了数字签名 | 10007 INVALID_USER_SIGNATURE | 本站不支持数字签名，在高德控制台关闭该 Key 的数字签名 |
| 服务器无法连接高德（restapi.amap.com）：… / 高德接口响应超时 | – | 网络问题，与 Key 无关，见「常见问题 → 系统诊断显示异常，但 Key 确认无误」 |

修改 `.env` 后执行 `docker compose up -d` 使其生效，再在系统诊断里确认。

### 天地图（可选，免费的地点搜索备用）

[天地图](https://www.tianditu.gov.cn/) 是国家地理信息公共服务平台，个人注册即可免费申请 Key。配置后：没有高德 Key、高德调用失败（Key 错误、额度用完）或高德搜不到时，地点搜索改用天地图；地图点选位置、打卡点自动命名在高德不可用时也会用天地图识别附近地点和地址。天地图的数据比高德少，建议作为高德的补充，而不是替代。

1. 打开 [天地图控制台](https://console.tianditu.gov.cn/) 注册并登录（需要手机号验证）
2. 「应用管理」→「创建新应用」，应用名称按「应用名称-应用场景」填写（如「TripHub-旅行地图」，信息不完整的应用可能被限流），**应用类型选择「服务端」**（浏览器端 Key 在服务器上调用会报「权限类型错误」）；如填写 IP 白名单，填服务器的公网出口 IP
3. 复制生成的 Key，填到 `.env` 的 `TIANDITU_KEY=`，然后 `docker compose up -d`
4. 在「管理后台 → 系统诊断」中确认「天地图」一项显示「正常」

天地图的坐标（CGCS2000，与 WGS-84 基本一致）由服务端自动转换为网站统一使用的 GCJ-02。天地图的接口格式按其公开文档实现；如果系统诊断显示正常但搜索结果不理想，可以只把它当作高德的备用。

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
配置完成后在「管理后台 → 系统诊断」查看「AI」一项：会实际向模型发一条消息，显示是否正常、用时，失败时给出原因（Key 无效、余额不足、模型不存在、超时、连不上等）。DeepSeek 返回 HTTP 402 表示**账户余额不足**，要在 DeepSeek 开放平台充值，换一个 Key 没有用。

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

每天自动备份数据库（可选）：执行 `crontab -e` 加入下面一行，每天 4 点备份、保留最近 14 天。把 `/root/triphub` 换成你的部署目录；crontab 里的 `%` 必须写成 `\%`。

```
0 4 * * * cd /root/triphub && mkdir -p backups && docker compose exec -T db pg_dump -U triphub --clean --if-exists triphub | gzip > backups/db-$(date +\%F).sql.gz && find backups -name 'db-*.sql.gz' -mtime +14 -delete
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

一直在同一个部署目录里升级：把新的发布包上传到部署目录，执行升级脚本即可。

> 从 v1.2.1 及更早的版本（部署目录名带版本号，如 `triphub-v1.2.0/`）升级：先按本节末尾的「从旧的目录结构迁移」操作一次。

```bash
cd /root/triphub                        # 你的部署目录
# 上传 triphub-v新版本.tar.gz（和 .sha256）到这里，然后：
./upgrade.sh triphub-v新版本.tar.gz       # 不写文件名时使用目录里版本号最新的正式版 triphub-v*.tar.gz
./upgrade.sh --backup triphub-v新版本.tar.gz   # 升级前先备份数据库（正式运营后建议加上）
```

脚本做的事情：

1. 检查：校验和（有 `.sha256` 文件时）、包的内容、能否连接 Docker、正在运行的 TripHub 是不是从本目录启动的
2. 先解压到临时目录，完整无误后再替换程序文件（`docker-compose.yml`、程序、`README.md` 等），磁盘满或中途按 Ctrl+C 不会留下新旧混杂的文件；**不会改动 `.env`、`data/`、`backups/` 和你自己添加的文件**（如 `docker-compose.override.yml`、证书）
3. 之后的步骤由新版本自带的脚本执行。加了 `--backup` 时先备份数据库到 `backups/pre-upgrade-日期-时间.sql.gz`（保留最近 5 个）
4. `docker compose up -d --build`：用新程序重建镜像并重启 app，数据库容器不动；数据库结构由程序启动时自动迁移
5. 等待 app 显示 `(healthy)`；`Caddyfile` 有变化时重启 Caddy；列出新版本新增的配置项（都有默认值，只做提示），删除旧版本的镜像

升级失败时脚本会显示日志和处理办法：排除原因后重新执行同一条命令，或者按下面的方法回滚。

不用脚本也可以手动升级（需要时先按第七节备份数据库）： `tar xzf triphub-v新版本.tar.gz && docker compose up -d --build`；启用了 HTTPS 的，`Caddyfile` 有变化时还要执行 `docker compose --profile https restart caddy`。

说明：

- 升级时网站会中断十几秒到几十秒。从较早的版本升级时，第一次启动可能要转换部分数据（日志出现 `converting numeric columns to double precision`），等 app 显示 `(healthy)` 后再访问。
- 自己的改动请放在 `.env` 或 `docker-compose.override.yml` 中：直接改 `docker-compose.yml`、`Caddyfile` 的内容会在升级时被覆盖。
- 启用了 HTTPS（Caddy）的，建议在 `.env` 中写上 `COMPOSE_PROFILES=https`：之后 `docker compose up -d`、`docker compose down` 都会自动带上 Caddy。

**回滚**：保留旧版本的发布包，执行 `./upgrade.sh triphub-v旧版本.tar.gz`（v1.2.1 及更早的旧格式发布包也可以）。旧版本一般可以直接使用升级后的数据库；如果旧版本启动失败，用升级前的备份还原（`--backup` 生成的在 `backups/` 下，按时间选对文件；升级后新产生的数据会丢失）：

```bash
docker compose stop app
docker compose exec -T db dropdb -U triphub --force triphub
docker compose exec -T db createdb -U triphub triphub
gunzip -c backups/pre-upgrade-日期-时间.sql.gz | docker compose exec -T db psql -U triphub -d triphub -v ON_ERROR_STOP=1 --single-transaction
docker compose up -d
```

### 从旧的目录结构迁移（v1.2.1 及更早，一次性）

v1.2.1 及更早的发布包解压出来是一个带版本号的目录（如 `/root/triphub-v1.2.1/`），每次升级换一个目录。改成固定的部署目录只需做一次，下面以旧目录 `/root/triphub-v1.2.1`、新的部署目录 `/root/triphub` 为例。

**第 1 步（只有启用了 HTTPS 的才需要）**：`docker ps` 里能看到 `triphub-caddy-1` 的，先编辑旧目录的 `.env`，写上（或取消注释）`COMPOSE_PROFILES=https`。否则下面的 `down` 不会停止 Caddy（它会继续使用旧目录里的文件，旧目录删除后 Caddy 就启动不了），新目录的 `up` 也不会启动 Caddy。

**第 2 步**：

```bash
OLD=/root/triphub-v1.2.1          # 换成你现在运行的目录（不确定时执行 docker compose ls 查看）
NEW=/root/triphub                 # 以后固定使用的部署目录
cd $OLD && docker compose down    # 停止当前运行的版本
mkdir -p $NEW
# 把配置、数据和你自己添加的文件移到部署目录（没有的会跳过）
for f in .env data backups docker-compose.override.yml ca.pem backup-*.sql.gz files-*.tar.gz; do [ -e "$f" ] && mv "$f" $NEW/; done
# 把新版本的发布包（和 .sha256）上传到 /root/triphub，然后：
cd $NEW && tar xzf triphub-v新版本.tar.gz     # 新格式的发布包：文件直接解压到这里
docker compose up -d --build
docker compose ps                 # app 显示 (healthy)；启用了 HTTPS 的，这里还应该有 caddy
```

**第 3 步：收尾**

- 旧目录里还有其它你自己添加的文件（如证书）的，也移到新目录；直接改过旧目录里 `docker-compose.yml` 的（如常见问题中的 MTU 设置），改写到新目录的 `docker-compose.override.yml` 中。
- 设置了第七节每日自动备份的，执行 `crontab -e`，把其中的目录改成新的部署目录。
- 旧目录先保留几天，确认新版本正常后再删除；删除前用 `ls -A /root/triphub-v1.2.1` 确认里面只剩发布包自带的文件。

容器名和数据卷不随目录变化（Compose 项目名固定为 `triphub`），账号、旅程和照片都会保留。之后的升级就只需要 `./upgrade.sh`；想退回迁移前的版本，执行 `./upgrade.sh triphub-v旧版本.tar.gz` 即可。

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

- **搜索不到具体店铺 / 民宿 / 酒店**：到「管理后台 → 系统诊断」查看高德一项的原因，最常见的是 Key 的服务平台不是「Web服务」，见第五节的表格。
- **AI 规划超时 / 很慢**：系统诊断中查看 AI 的用时；确认 `AI_THINKING` 为 `off`（缺省），换用更快的模型（如 DeepSeek 的 `deepseek-flash`），或调大 `AI_TIMEOUT`。
- **地图空白 / 只显示省界轮廓**：浏览器访问不到高德瓦片服务器（`webrd0x.is.autonavi.com`），检查网络；页面会自动退回到内置的省界底图。
- **定位失败**：确认是 HTTPS 访问，并在手机浏览器 / 微信中允许定位权限。
- **iPhone 上传的照片没有位置**：在系统相册选择照片时点「选项」打开「位置」；或者在微信外用 Safari 打开网站。
- **忘记管理员密码**：修改 `.env` 中的 `ADMIN_PASSWORD` 不会覆盖已有账号的密码。在部署目录执行 `docker compose exec app /triphub reset-password -user 管理员用户名`，会重置为随机密码并显示出来（也可以加 `-password '新密码'` 自己指定），该账号在所有设备上的登录随之失效，登录后可在「账号设置」中改成自己的密码。
- **app 启动后立即退出或反复重启**：执行 `docker compose logs app` 查看原因。常见原因：`.env` 中的 `ADMIN_PASSWORD` 仍是示例值或不足 8 位；`JWT_SECRET` 填了但不足 32 个字符（留空会自动生成）；`GOMEMLIMIT` 单位写错（日志出现 `malformed GOMEMLIMIT`，应写成 `800MiB`、`1500MiB` 这样）。
- **普通用户忘记密码**：管理员在「管理后台 → 用户管理」中对该用户执行「重置密码」，会生成一个新密码（转告用户，用户登录后可在「账号设置」中修改），该用户在所有设备上的登录随之失效。
- **修改 `.env` 后没生效**：要执行 `docker compose up -d` 重新创建容器；`docker compose restart` 不会重新读取 `.env`。
- **系统诊断显示异常，但 Key 确认无误**：先看诊断里的「技术细节」——「失败环节」是 DNS 解析 / 代理 / TCP 连接 / TLS 握手 / 等待响应时，是服务器（容器）的网络问题，与 Key 无关；「原始错误」是 Go 的原始报错（Key 已隐藏），失败时也会写入 `docker compose logs app`（`diagnostics check failed`）。在部署目录运行自检，它在容器里逐项检查代理、DNS、TCP、TLS，并用与服务端相同的代码真实调用一次各服务（不连数据库，Key 只显示长度和首尾字符；全部正常时退出码为 0）：
  ```bash
  docker compose exec app /triphub -diagnose
  # app 在反复重启时：docker compose run --rm --no-deps app -diagnose
  ```
  常见原因：
  - **容器用的还是旧配置**：改了 `.env` 却只执行了 `docker compose restart`。执行 `docker compose up -d`，再对照诊断中 Key 的长度和首尾字符。
  - **Key 里混入了多余字符**：引号、行尾注释、复制带来的零宽字符 / BOM、换行。服务端启动时会自动去掉并在日志中警告（`配置值含有多余字符`），但请改正 `.env`：每行写成 `AMAP_KEY=你的Key`，注释单独占一行。
  - **Docker 注入了代理**：`~/.docker/config.json`（用 sudo 时是 `/root/.docker/config.json`）里的 `proxies` 会被注入每个容器（`HTTPS_PROXY`）。容器里的 `127.0.0.1` 是容器自己，连不到宿主机上的代理，诊断显示「代理」环节失败。删掉 `proxies`（或改成容器能访问的地址、加 `noProxy`），然后 `docker compose up -d --force-recreate app`。
  - **容器 DNS 不通**：宿主机只配置了本机 DNS（如 `127.0.0.1` 上的 dnsmasq）、Docker 找不到可用的上游 DNS 时，会给容器改用 8.8.8.8，国内可能不通；使用 systemd-resolved（`127.0.0.53`，Ubuntu 默认）时 Docker 会读取 `/run/systemd/resolve/resolv.conf` 中的上游 DNS，也要确认那里的 DNS 可用。在 `/etc/docker/daemon.json` 写入 `{"dns": ["223.5.5.5", "119.29.29.29"]}`，`systemctl restart docker` 后 `docker compose up -d`。
  - **DNS 通过、TCP 超时（容器出不了网）**：容器里的 DNS 由宿主机上的 Docker 代为查询，所以 DNS 正常不代表容器能上网。先在宿主机上执行 `curl -sS -m 8 -o /dev/null -w '%{http_code}\n' https://restapi.amap.com`：宿主机能连而容器不能，就是 Docker 的转发 / NAT 规则失效了。依次检查：
    ```bash
    sysctl net.ipv4.ip_forward              # 应为 1；为 0 时：sysctl -w net.ipv4.ip_forward=1 并写入 /etc/sysctl.d/99-docker.conf
    iptables -t nat -S POSTROUTING | grep MASQUERADE   # 应有 Docker 网段（172.x）的 MASQUERADE 规则
    systemctl is-active nftables firewalld ufw 2>/dev/null   # 这些服务重载时会清掉 Docker 的规则
    ```
    修复：`systemctl restart docker`（重新写入规则），再在部署目录 `docker compose up -d`。
    **开启了 ufw 的**（`systemctl is-active ufw` 显示 active）：ufw 默认拒绝转发流量，容器出网正好要经过宿主机转发。执行 `ufw default allow routed && ufw reload`（只放开转发，不影响 SSH 等入站规则），再 `systemctl restart docker` 和 `docker compose up -d`。Debian 上如果 `nftables` 服务的配置里有 `flush ruleset`，每次开机或重载都会清掉 Docker 的规则：不需要它时 `systemctl disable --now nftables`，然后重启 Docker。
  - **防火墙 / 安全组**：`firewall-cmd --reload` 或改过 iptables 后要重启 Docker，否则容器出站的 NAT 规则会丢失；确认安全组放行出站 443；`daemon.json` 中不要设置 `"iptables": false`。
  - **MTU**：TCP 能连上但 TLS 握手超时，而宿主机上 `curl` 正常，多半是云服务器 / VPN 网卡的 MTU 小于 1500。用 `ip link` 查看网卡 MTU（如 1450），在部署目录的 `docker-compose.override.yml` 中加上下面的内容（文件已存在时合并进去；不要改 `docker-compose.yml`，升级时会被覆盖），然后 `docker compose down && docker compose up -d`：
    ```yaml
    networks:
      default:
        driver_opts:
          com.docker.network.driver.mtu: "1450"
    ```
  - **服务器时间不对**：TLS 证书校验失败（证书已过期或尚未生效）时用 `timedatectl` 检查时间。
  - **HTTPS 被劫持检查**：诊断显示「TLS 证书不受信任（unknown authority）」，通常是公司 / 机房的防火墙或安全网关对 HTTPS 做了解密检查。镜像内置的是公共根证书，不认识这类网关的证书。向网络管理员要到网关的 CA 证书（PEM 格式，与公共根证书合并成一个文件），放在部署目录如 `ca.pem`，新建 `docker-compose.override.yml`（已有这个文件时合并进去）：
    ```yaml
    services:
      app:
        volumes:
          - ./ca.pem:/etc/ssl/ca.pem:ro
        environment:
          SSL_CERT_FILE: /etc/ssl/ca.pem
    ```
    然后 `docker compose up -d`。
  - **DeepSeek 余额不足**：诊断显示「AI 账户余额不足」（HTTP 402）时到 DeepSeek 开放平台充值。
- **修改数据库密码**：`DB_PASSWORD` 只在第一次启动（`data/postgres` 为空）时用来初始化数据库，之后直接改 `.env` 会导致 app 日志出现 `password authentication failed`。正确做法：先执行 `docker compose exec db psql -U triphub -d triphub -c "ALTER USER triphub PASSWORD '新密码'"`，再把 `.env` 的 `DB_PASSWORD` 改成同一个值，然后 `docker compose up -d`。（首次部署、还没有任何数据时，也可以 `docker compose down && rm -rf data/postgres` 后重新启动。）
- **HTTPS 没生效**：Caddy 要等 app 显示 `(healthy)` 后才启动，先用 `docker compose ps` 确认 app 正常；再执行 `docker compose logs caddy` 查看原因（常见：`.env` 未设置 `DOMAIN`、域名未解析到本机、80/443 端口被占用或安全组未放行、国内服务器域名未备案）。
