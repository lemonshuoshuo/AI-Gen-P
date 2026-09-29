#!/usr/bin/env bash
# TripHub 原地升级：在部署目录执行
#   ./upgrade.sh triphub-v新版本.tar.gz      # 不写文件名时使用本目录里版本号最新的正式版 triphub-vX.Y.Z.tar.gz
#   ./upgrade.sh --backup triphub-v新版本.tar.gz   # 升级前先把数据库备份到 backups/（正式运营后建议加上）
# 步骤：检查 → 解压到临时目录、确认完整后替换程序文件 →（--backup 时备份数据库）→ 重建镜像并重启 → 等待启动完成 → 清理旧版本镜像
# 不会改动 .env、data/、backups/ 以及你自己添加的文件（如 docker-compose.override.yml）；数据库结构由程序启动时自动迁移。
# 回滚：./upgrade.sh triphub-v旧版本.tar.gz（保留旧的发布包即可，v1.2.1 及更早的旧格式发布包也可以）
#
# 替换文件之后的步骤由新版本自己的脚本执行（bash ./upgrade.sh --after-extract 发布包），
# 这样新版本对升级步骤的修改在这次升级中就会生效。以后的版本要一直保留这个入口（回滚到旧版本时也会用到）。
set -euo pipefail

die() {
  echo "错误：$*" >&2
  exit 1
}

# app 容器的 ID，没有运行时为空（不用 docker compose ps --format 模板：Compose 2.21 之前不支持）
app_container() {
  docker compose ps -q app 2>/dev/null | head -n 1 || true
}

# 当前运行的 app 镜像（如 triphub:v1.2.1），没有运行时为空
current_image() {
  local cid
  cid=$(app_container)
  [ -z "$cid" ] || docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true
}

# 正在运行的 Caddy 容器（启用 HTTPS 时才有），项目名固定为 triphub
caddy_container() {
  docker ps -q --filter label=com.docker.compose.project=triphub --filter label=com.docker.compose.service=caddy | head -n 1
}

# 等待 app 的健康检查通过（首次启动或迁移数据库可能要几十秒）
wait_healthy() {
  local _ cid status
  for _ in $(seq 1 90); do
    cid=$(app_container)
    status=
    if [ -n "$cid" ]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
    fi
    case "$status" in
      healthy | running) return 0 ;; # running：没有健康检查（在 override 里关掉了）
      unhealthy) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

# 新版本 .env.example 里有、而 .env 里没有的配置项（都有默认值，只做提示）
report_new_settings() {
  local keys missing=()
  keys=$(grep -E '^[A-Z][A-Z0-9_]*=' .env.example | cut -d= -f1 || true)
  for k in $keys; do
    grep -qE "^[[:space:]]*${k}=" .env || missing+=("$k")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "    新版本新增的配置项（有默认值，不填也能运行；需要时从 .env.example 复制到 .env）：${missing[*]}"
  fi
}

# 本目录里版本号最新的正式版发布包（跳过 -rc1、-test 这类测试版）
newest_package() {
  local f
  for f in triphub-v*.tar.gz; do
    if [[ $f =~ ^triphub-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$ ]]; then echo "$f"; fi
  done | sort -V | tail -n 1
}

# 正在运行的 TripHub 必须是从本目录启动的。Compose 项目名固定为 triphub，在别的目录执行 up 会接管旧容器，
# 并改用本目录的 data/（从带版本号的旧目录迁移时漏了步骤就会这样，网站会变成一个空数据库）
check_project_dir() {
  local here wd
  here=$(pwd -P)
  while IFS= read -r wd; do
    [ -n "$wd" ] || continue
    if [ "$(cd "$wd" 2>/dev/null && pwd -P)" != "$here" ]; then
      die "TripHub 的容器是从另一个目录启动的：$wd
    本目录是 $(pwd)，没有做任何改动。
    从带版本号的旧目录（v1.2.1 及更早）迁移：按 README「八、升级」→「从旧的目录结构迁移」操作，把 .env、data/ 等移到本目录后再执行本脚本。
    已经把配置和数据都移到了本目录：先在本目录执行 docker compose --profile https down 停止旧容器，再重新执行本脚本。"
    fi
  done < <(docker ps -a --filter label=com.docker.compose.project=triphub --format '{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)
}

# 先解压到部署目录里的临时目录（同一块磁盘），完整无误后再逐个改名替换：
# 磁盘满或按 Ctrl+C 只会停在替换之前，不会留下新旧混杂的文件（包括 upgrade.sh 自己）
install_package() {
  local pkg=$1 strip=$2 tmp=.upgrade-tmp f
  local opts=(--no-same-owner)
  [ "$strip" = 0 ] || opts+=(--strip-components=1)
  rm -rf "$tmp"
  mkdir "$tmp"
  trap 'rm -rf .upgrade-tmp' EXIT
  tar -xzf "$pkg" "${opts[@]}" -C "$tmp" || die "解压失败（磁盘空间不足？），程序文件没有改动。处理后重新执行：./upgrade.sh $pkg"
  for f in docker-compose.yml Dockerfile; do
    [ -s "$tmp/$f" ] || die "发布包不完整（缺少 $f），程序文件没有改动"
  done
  # 改名替换很快，这几步不让 Ctrl+C / 断开 SSH 打断；upgrade.sh 最后替换（正在执行的旧脚本内容不受影响）
  trap '' INT HUP TERM
  (cd "$tmp" && find . -type f ! -path ./upgrade.sh -print0) | while IFS= read -r -d '' f; do
    mkdir -p "$(dirname "$f")"
    mv -f "$tmp/$f" "$f"
  done
  [ ! -f "$tmp/upgrade.sh" ] || mv -f "$tmp/upgrade.sh" upgrade.sh
  trap - INT HUP TERM
  rm -rf "$tmp"
  trap - EXIT
}

# 升级前备份数据库到 backups/（保留最近 5 个）：回滚到旧版本、而旧版本用不了升级后的数据库时，用它还原。
# 只在 --backup 时执行（TRIPHUB_UPGRADE_BACKUP=1 由第一阶段传给新版本的脚本）
backup_database() {
  local pkg=$1 f
  [ "${TRIPHUB_UPGRADE_BACKUP:-}" = 1 ] || return 0
  if [ -z "$(docker compose ps -q db 2>/dev/null || true)" ]; then
    echo "    数据库没有在运行，跳过升级前的备份"
    return 0
  fi
  f="backups/pre-upgrade-$(date +%Y%m%d-%H%M%S).sql.gz"
  echo "==> 备份数据库到 $f"
  mkdir -p backups
  if ! (umask 077 && docker compose exec -T db pg_dump -U triphub --clean --if-exists triphub | gzip >"$f.tmp"); then
    rm -f "$f.tmp"
    die "备份数据库失败（磁盘空间不足？），网站还在运行旧版本，程序文件已经换成新版本。处理后重新执行：./upgrade.sh $pkg"
  fi
  mv "$f.tmp" "$f"
  printf '%s\n' backups/pre-upgrade-*.sql.gz | sort -r | tail -n +6 | xargs -r rm -f --
}

# 启动失败：显示状态和日志，告诉用户怎么办
fail() {
  docker compose ps || true
  docker compose logs --tail 80 app || true
  die "$1，原因见上面的日志。程序文件已经是新版本：排除原因后重新执行 ./upgrade.sh $2
    或者回滚：./upgrade.sh 旧版本的发布包（用了 --backup 时，升级前的数据库备份在 backups/ 下）"
}

# 替换文件之后的步骤：由刚解压出来的新版本脚本执行
after_extract() {
  local pkg="${1:-新版本的发布包}" old new caddy
  old=$(current_image)
  new=$(sed -n 's/^[[:space:]]*image:[[:space:]]*triphub:\([^[:space:]]*\).*/\1/p' docker-compose.yml | head -n 1)
  echo "    ${old:-（当前没有运行）} → triphub:${new:-?}"
  report_new_settings

  # 启用了 HTTPS（Caddy）却没有在 .env 里写 COMPOSE_PROFILES=https 时，up / down 不会管 caddy，提醒一下
  if [ -n "$(caddy_container)" ] && ! grep -qE '^[[:space:]]*COMPOSE_PROFILES=.*https' .env; then
    echo "    提示：Caddy 正在运行，但 .env 中没有 COMPOSE_PROFILES=https；建议加上，之后 docker compose up / down 会自动带上 Caddy"
  fi

  backup_database "$pkg"

  echo "==> 重建镜像并重启（数据库结构由程序启动时自动迁移）"
  docker compose up -d --build || fail "启动失败" "$pkg"

  echo "==> 等待启动完成…"
  wait_healthy || fail "app 没有在 3 分钟内启动完成" "$pkg"

  # Caddyfile 是单个文件挂载：文件被替换后，正在运行的 Caddy 仍读取旧文件，内容不同时重启 Caddy
  caddy=$(caddy_container)
  if [ -n "$caddy" ] && ! docker exec "$caddy" cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - Caddyfile; then
    echo "==> Caddyfile 有更新，重启 Caddy"
    docker restart "$caddy" >/dev/null || echo "    警告：重启 Caddy 失败，请执行 docker compose --profile https restart caddy"
  fi
  docker compose ps

  # 清理旧版本镜像（正在使用的镜像删不掉，会被跳过）
  if [ -n "$new" ]; then
    docker images triphub --format '{{.Repository}}:{{.Tag}}' | grep -vx "triphub:$new" | grep -v ':<none>$' |
      xargs -r docker rmi >/dev/null 2>&1 || true
  fi

  echo
  echo "完成：TripHub ${new:-新版本} 已启动。"
  echo "检查高德 / AI 是否可用：docker compose exec app /triphub -diagnose"
}

main() {
  if [ "${1:-}" = "--after-extract" ]; then
    cd "$(dirname "$0")"
    after_extract "${2:-}"
    return
  fi

  local pkg="" arg
  for arg in "$@"; do
    case "$arg" in
      --backup) export TRIPHUB_UPGRADE_BACKUP=1 ;;
      -*) die "不认识的参数：$arg（用法：./upgrade.sh [--backup] [triphub-v版本号.tar.gz]）" ;;
      *) pkg=$arg ;;
    esac
  done
  # 发布包路径按执行命令时的当前目录解析，然后切换到部署目录（本脚本所在目录）
  if [ -n "$pkg" ]; then
    [ -f "$pkg" ] || die "找不到发布包：$pkg"
    pkg="$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")"
  fi
  cd "$(dirname "$0")"

  if [ -z "$pkg" ]; then
    pkg=$(newest_package)
    [ -n "$pkg" ] || die "找不到发布包。把 triphub-v版本号.tar.gz 上传到 $(pwd) 后执行：./upgrade.sh triphub-v版本号.tar.gz（测试版要写出文件名）"
    pkg="$(pwd)/$pkg"
  fi
  [ -f .env ] || die "$(pwd) 下没有 .env。
    首次部署：cp .env.example .env 并修改，再执行 docker compose up -d --build
    从 v1.2.1 及更早的版本（带版本号的目录）迁移：按 README「八、升级」→「从旧的目录结构迁移」操作"
  command -v docker >/dev/null 2>&1 || die "没有找到 docker"
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose 插件（docker compose）"
  docker info >/dev/null 2>&1 || die "无法连接 Docker：请用 root（或 sudo）执行，并确认 Docker 正在运行"
  check_project_dir
  # 数据库目录必须在本目录，否则 up 会新建一个空数据库
  if [ ! -d data/postgres ] || { [ -r data/postgres ] && [ -z "$(ls -A data/postgres)" ]; }; then
    die "$(pwd) 下没有数据库（data/postgres），没有做任何改动。从旧目录迁移时要把 data/ 一起移过来；首次部署请执行 docker compose up -d --build"
  fi

  # 校验和：同目录有 .sha256 文件时核对，避免用上传不完整的包
  if [ -f "$pkg.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
    local dir base
    dir=$(dirname "$pkg")
    base=$(basename "$pkg")
    (cd "$dir" && sha256sum -c "$base.sha256" >/dev/null 2>&1) || die "发布包校验失败，文件可能没有上传完整：$pkg"
  fi

  # 检查包的内容。新格式：文件直接在包的根目录；v1.2.1 及更早：多一层 triphub-v版本号/ 目录（回滚到这些版本时），解压时去掉这一层
  local list top strip=0
  list=$(tar -tzf "$pkg" | sed 's#^\./##') || die "无法读取发布包：$pkg"
  if ! grep -qxF docker-compose.yml <<<"$list"; then
    top=$(cut -d/ -f1 <<<"$list" | sort -u)
    if ! [[ $top =~ ^triphub-[A-Za-z0-9_.-]+$ ]] || ! grep -qxF "$top/docker-compose.yml" <<<"$list"; then
      die "$pkg 不是 TripHub 的发布包（里面没有 docker-compose.yml）"
    fi
    strip=1
    list=$(sed 's#^[^/]*/##' <<<"$list")
  fi
  # 用 here-string 而不是管道：grep -q 提前退出时管道会因 SIGPIPE 在 pipefail 下被判为失败
  if grep -Eq '^/|(^|/)\.\.(/|$)|^(\.env|data|backups)(/|$)' <<<"$list"; then
    die "发布包内容异常（包含 .env、data/、backups/ 或越界路径），已停止"
  fi

  echo "==> 解压 $pkg"
  install_package "$pkg" "$strip"
  exec bash ./upgrade.sh --after-extract "$pkg"
}

# bash 边读边执行脚本：所有步骤都在 main 里，最后这一行读入后才开始执行
main "$@"; exit $?
