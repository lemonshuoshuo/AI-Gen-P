#!/usr/bin/env bash
# 构建 TripHub 发布包：前端打包 → 嵌入 Go 二进制（linux amd64 / arm64）→ 生成 tar.gz
# 依赖：Node.js 22.12+（或 20.19+）、Go 1.27+
# 用法：scripts/build-release.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)}"
# 版本号用于目录名、文件名和镜像标签，只保留安全字符（feature/x -> feature-x）
VERSION="$(printf '%s' "$VERSION" | tr -c 'A-Za-z0-9_.-' '-')"
OUT="$ROOT/dist/triphub-$VERSION"
WEBUI="$ROOT/server/internal/webui/dist"

# Node 版本过低时 npm 会跳过 Vite 的原生模块，构建只报 "Cannot find native binding"，这里提前给出明确提示
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===20&&b>=19)||(a===22&&b>=12)||a>=23)){console.error("需要 Node.js 20.19+ 或 22.12+，当前 "+process.version);process.exit(1)}'

echo "==> 构建前端"
cd "$ROOT/web"
# 每次都按 package-lock.json 全新安装依赖，保证发布包可复现
npm ci --no-audit --no-fund
npm run build

echo "==> 嵌入前端资源"
find "$WEBUI" -mindepth 1 ! -name '.keep' -exec rm -rf {} + 2>/dev/null || true
cp -r "$ROOT/web/dist/." "$WEBUI/"

echo "==> 编译后端 ($VERSION)"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$ROOT/server"
echo "    $(go version)"
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X triphub/internal/version.Version=$VERSION" \
    -o "$OUT/triphub-linux-$arch" ./cmd/triphub
  echo "    triphub-linux-$arch"
done

echo "==> 清理嵌入目录"
find "$WEBUI" -mindepth 1 ! -name '.keep' -exec rm -rf {} +

echo "==> 组装发布包"
cp "$ROOT/deploy/Dockerfile" "$ROOT/deploy/.dockerignore" "$ROOT/deploy/.env.example" "$ROOT/deploy/Caddyfile" \
   "$ROOT/deploy/nginx.conf.example" "$ROOT/LICENSE" "$ROOT/CHANGELOG.md" "$OUT/"
cp "$ROOT/deploy/upgrade.sh" "$OUT/upgrade.sh"
chmod 755 "$OUT/upgrade.sh" "$OUT"/triphub-linux-*
cp "$ROOT/docs/DEPLOY.md" "$OUT/README.md"
cp "$ROOT/docs/API.md" "$OUT/API.md"
# 镜像标签固定为本包的版本号：升级后 docker compose 会按新标签重建镜像并重启 app
# 输出到新文件而不用 sed -i（macOS 的 BSD sed 不兼容 GNU 的 -i 写法）
sed "s|triphub:\${TRIPHUB_VERSION:-latest}|triphub:$VERSION|" "$ROOT/deploy/docker-compose.yml" > "$OUT/docker-compose.yml"
grep -qF "image: triphub:$VERSION" "$OUT/docker-compose.yml" || { echo "docker-compose.yml 中未找到镜像标签，无法写入版本号" >&2; exit 1; }

# 包里的文件直接放在根目录（没有版本号目录）：在部署目录解压即覆盖程序文件，.env 和 data/ 不受影响。
# 属主记为 root，避免在服务器上解压出构建机的 uid
cd "$ROOT/dist"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  owner=(--owner=0 --group=0 --numeric-owner)
else
  owner=(--uid 0 --gid 0) # macOS 的 bsdtar
fi
# 文件名都是固定的（不含空格），按名单打包，不把 "./" 本身打进去（否则解压时会改掉部署目录的权限）
files=()
while IFS= read -r f; do files+=("$f"); done < <(cd "triphub-$VERSION" && ls -A)
(cd "triphub-$VERSION" && tar czf "../triphub-$VERSION.tar.gz" "${owner[@]}" "${files[@]}")
# 校验和：上传到服务器后可用 sha256sum -c 核对文件是否完整
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "triphub-$VERSION.tar.gz"
else
  shasum -a 256 "triphub-$VERSION.tar.gz"
fi > "triphub-$VERSION.tar.gz.sha256"
echo
echo "完成：dist/triphub-$VERSION.tar.gz（校验和：dist/triphub-$VERSION.tar.gz.sha256）"
ls -lh "triphub-$VERSION.tar.gz"
