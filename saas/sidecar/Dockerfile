# Build context must be the repository root:
# docker build -f saas/sidecar/Dockerfile .
FROM alpine:3.20 AS engine
RUN apk add --no-cache nasm
WORKDIR /src
COPY src/ src/
RUN nasm -f bin -dLINUX -I src/ src/main.asm -o asmdb && chmod +x asmdb

FROM golang:1.25-alpine AS build
WORKDIR /src/saas/sidecar
COPY saas/sidecar/go.mod ./
COPY saas/sidecar/*.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/sidecar .

FROM alpine:3.20
RUN addgroup -S asmdb && adduser -S -G asmdb asmdb && mkdir -p /app /data && chown -R asmdb:asmdb /data
COPY --from=engine /src/asmdb /app/asmdb
COPY --from=build /out/sidecar /app/sidecar
USER asmdb
EXPOSE 8080
ENTRYPOINT ["/app/sidecar"]
