# Build context must be the repository root:
#   az acr build --file saas/sidecar/Dockerfile .
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS engine
RUN apk add --no-cache nasm
WORKDIR /src
COPY src/ src/
RUN nasm -f bin -dLINUX -I src/ src/main.asm -o asmdb && chmod +x asmdb

# The sidecar is standard library only, so there is nothing to download and no
# go.sum to verify: the whole dependency surface is the Go release itself.
FROM golang:1.25-alpine@sha256:56961d79ea8129efddcc0b8643fd8a5416b4e6228cfd477e3fd61deb2672c587 AS build
WORKDIR /src/saas/sidecar
COPY saas/sidecar/go.mod ./
COPY saas/sidecar/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/sidecar .

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache su-exec \
 && addgroup -S asmdb && adduser -S -G asmdb asmdb \
 && mkdir -p /app /data
COPY --from=engine /src/asmdb /app/asmdb
COPY --from=build /out/sidecar /app/sidecar
COPY saas/sidecar/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
EXPOSE 8080
# Starts as root only long enough to take ownership of the mounted volume, then
# drops to asmdb for the life of the process. See entrypoint.sh.
ENTRYPOINT ["/app/entrypoint.sh"]
