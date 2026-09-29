#!/usr/bin/env bash
# TripHub 原地升级：在部署目录执行
#   ./upgrade.sh triphub-v新版本.tar.gz      # 不写文件名时使用本目录里版本号最新的 triphub-v*.tar.gz
# 步骤：解压新版本覆盖程序文件 → 重建镜像并重启 → 等待启动完成 → 清理旧版本镜像
# 不会改动 .env、data/ 以及你自己添加的文件（如 docker-compose.override.yml）；数据库结构由程序启动时自动迁移。
# 回滚：./upgrade.sh triphub-v旧版本.tar.gz（保留旧的发布包即可）
set -euo pipefail

die() {
  echo "错误：$*" >&2
  exit 1
}

# 当前运行的 app 镜像（如 triphub:v1.2.1），没有运行时为空
current_image() {
  docker compose ps app --format '{{.Image}}' 2>/dev/null | head -n 1 || true
}

# 等待 app 的健康检查通过（首次启动或迁移数据库可能要几十秒）
wait_healthy() {
  local _ status
  for _ in $(seq 1 90); do
    status=$(docker compose ps app --format '{{.Status}}' 2>/dev/null | head -n 1 || true)
    case "$status" in
      *"(healthy)"*) return 0 ;;
      *"(unhealthy)"*) return 1 ;;
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

main() {
  local pkg="${1:-}"
  # 发布包路径按执行命令时的当前目录解析，然后切换到部署目录（本脚本所在目录）
  if [ -n "$pkg" ]; then
    [ -f "$pkg" ] || die "找不到发布包：$pkg"
    pkg="$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")"
  fi
  cd "$(dirname "$0")"

  if [ -z "$pkg" ]; then
    pkg=$(ls -1 triphub-v*.tar.gz 2>/dev/null | sort -V | tail -n 1 || true)
  fi
  [ -n "$pkg" ] && [ -f "$pkg" ] || die "找不到发布包。把 triphub-v版本号.tar.gz 上传到 $(pwd) 后执行：./upgrade.sh triphub-v版本号.tar.gz"
  [ -f .env ] || die "$(pwd) 下没有 .env。首次部署请先 cp .env.example .env 并修改，再执行 docker compose up -d --build"
  command -v docker >/dev/null 2>&1 || die "没有找到 docker"
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose 插件（docker compose）"

  # 校验和：同目录有 .sha256 文件时核对，避免用上传不完整的包
  if [ -f "$pkg.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
    local dir base
    dir=$(dirname "$pkg")
    base=$(basename "$pkg")
    (cd "$dir" && sha256sum -c "$base.sha256" >/dev/null 2>&1) || die "发布包校验失败，文件可能没有上传完整：$pkg"
  fi

  # 检查包的内容：必须是新格式（文件直接在包的根目录），且不包含 .env、data/ 或越界路径
  local list
  list=$(tar -tzf "$pkg") || die "无法读取发布包：$pkg"
  # 用 here-string 而不是管道：grep -q 提前退出时管道会因 SIGPIPE 在 pipefail 下被判为失败
  if grep -Eq '^/|(^|/)\.\.(/|$)|^(\./)?(\.env|data)(/|$)' <<<"$list"; then
    die "发布包内容异常（包含 .env、data/ 或越界路径），已停止"
  fi
  grep -Eq '^(\./)?docker-compose\.yml$' <<<"$list" ||
    die "$pkg 不是新格式的发布包（v1.2.1 及更早的包里多一层版本目录），请按 README「八、升级」中的「从旧的目录结构迁移」操作一次"

  local old new
  old=$(current_image)
  echo "==> 解压 $pkg"
  tar -xzf "$pkg" --no-same-owner
  new=$(sed -n 's/^[[:space:]]*image:[[:space:]]*triphub:\([^[:space:]]*\).*/\1/p' docker-compose.yml | head -n 1)
  echo "    ${old:-（当前没有运行）} → triphub:${new:-?}"
  report_new_settings

  # 启用了 HTTPS（Caddy）却没有在 .env 里写 COMPOSE_PROFILES=https 时，up 不会管 caddy，提醒一下
  if [ -n "$(docker ps -q --filter label=com.docker.compose.project=triphub --filter label=com.docker.compose.service=caddy)" ] &&
    ! grep -qE '^[[:space:]]*COMPOSE_PROFILES=.*https' .env; then
    echo "    提示：Caddy 正在运行，但 .env 中没有 COMPOSE_PROFILES=https；加上后以后升级会一并更新 Caddy"
  fi

  echo "==> 重建镜像并重启（数据库结构由程序启动时自动迁移）"
  docker compose up -d --build

  echo "==> 等待启动完成…"
  if ! wait_healthy; then
    docker compose ps
    docker compose logs --tail 80 app || true
    die "app 没有在 3 分钟内启动完成，日志见上。回滚：./upgrade.sh 旧版本的发布包"
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

# 整个脚本先读完再执行：解压时 upgrade.sh 自己也会被新版本替换
main "$@"
exit $?
