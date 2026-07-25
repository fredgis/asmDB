# Build context must be the repository root:
#   az acr build --file saas/sidecar/Dockerfile .
FROM alpine:3.20 AS engine
RUN apk add --no-cache nasm
WORKDIR /src
COPY src/ src/
RUN nasm -f bin -dLINUX -I src/ src/main.asm -o asmdb && chmod +x asmdb

# The sidecar is standard library only, so there is nothing to download and no
# go.sum to verify: the whole dependency surface is the Go release itself.
FROM golang:1.25-alpine AS build
WORKDIR /src/saas/sidecar
COPY saas/sidecar/go.mod ./
COPY saas/sidecar/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/sidecar .

FROM alpine:3.20
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
