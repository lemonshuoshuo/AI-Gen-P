# TripHub 源码构建镜像（前端 + 后端打包成单个静态二进制，运行镜像基于 scratch）
# 国内构建可传入镜像加速参数，例如：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine \
#                --build-arg GO_IMAGE=docker.m.daocloud.io/library/golang:1.24-alpine \
#                --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#                --build-arg GOPROXY=https://goproxy.cn,direct -t triphub .
ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.24-alpine

FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY web/ ./
RUN npm run build

FROM ${GO_IMAGE} AS server
ARG GOPROXY=https://proxy.golang.org,direct
ARG VERSION=dev
ENV CGO_ENABLED=0 GOPROXY=${GOPROXY}
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/web/dist ./internal/webui/dist
RUN go build -trimpath -ldflags "-s -w -X triphub/internal/version.Version=${VERSION}" -o /out/triphub ./cmd/triphub

FROM scratch
COPY --from=server /out/triphub /triphub
# 上传大文件时 Go 需要临时目录
WORKDIR /tmp
WORKDIR /
ENV TRIPHUB_ADDR=:8080 TRIPHUB_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/triphub"]
