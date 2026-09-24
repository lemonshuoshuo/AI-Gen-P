# 运行镜像：直接使用发布包里编译好的二进制，不需要拉取任何基础镜像
FROM scratch
ARG TARGETARCH=amd64
COPY triphub-linux-${TARGETARCH} /triphub
WORKDIR /tmp
WORKDIR /
ENV TRIPHUB_ADDR=:8080 TRIPHUB_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/triphub"]
