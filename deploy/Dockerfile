# 运行镜像：直接使用发布包里编译好的二进制，不需要拉取任何基础镜像
FROM scratch
# TARGETARCH 由 BuildKit 按服务器架构自动设置（amd64/arm64），不要给默认值；旧版构建器没有该变量时回退为 amd64
ARG TARGETARCH
COPY triphub-linux-${TARGETARCH:-amd64} /triphub
WORKDIR /tmp
WORKDIR /
ENV TRIPHUB_ADDR=:8080 TRIPHUB_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/triphub"]
