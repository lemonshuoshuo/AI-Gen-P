#!/usr/bin/env bash
# 构建 TripHub 发布包：前端打包 → 嵌入 Go 二进制（linux amd64 / arm64）→ 生成 tar.gz
# 依赖：Node.js 20+、Go 1.24+
# 用法：scripts/build-release.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)}"
OUT="$ROOT/dist/triphub-$VERSION"
WEBUI="$ROOT/server/internal/webui/dist"

echo "==> 构建前端"
cd "$ROOT/web"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build

echo "==> 嵌入前端资源"
find "$WEBUI" -mindepth 1 ! -name '.keep' -exec rm -rf {} + 2>/dev/null || true
cp -r "$ROOT/web/dist/." "$WEBUI/"

echo "==> 编译后端 ($VERSION)"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$ROOT/server"
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X triphub/internal/version.Version=$VERSION" \
    -o "$OUT/triphub-linux-$arch" ./cmd/triphub
  echo "    triphub-linux-$arch"
done

echo "==> 清理嵌入目录"
find "$WEBUI" -mindepth 1 ! -name '.keep' -exec rm -rf {} +

echo "==> 组装发布包"
cp "$ROOT/deploy/Dockerfile" "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/.env.example" \
   "$ROOT/deploy/Caddyfile" "$ROOT/deploy/nginx.conf.example" "$OUT/"
cp "$ROOT/docs/DEPLOY.md" "$OUT/README.md"
cp "$ROOT/docs/API.md" "$OUT/API.md"
sed -i "s/^TRIPHUB_VERSION=.*//" "$OUT/.env.example"
echo "TRIPHUB_VERSION=$VERSION" >> "$OUT/.env.example"

cd "$ROOT/dist"
tar czf "triphub-$VERSION.tar.gz" "triphub-$VERSION"
echo
echo "完成：dist/triphub-$VERSION.tar.gz"
ls -lh "triphub-$VERSION.tar.gz"
