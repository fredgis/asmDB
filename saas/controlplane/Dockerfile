# Build context must be the repository root:
#   az acr build --file saas/controlplane/Dockerfile .
FROM golang:1.25-alpine AS build
WORKDIR /src

# Dependencies first, as their own layer: the Azure SDK is by far the slowest
# part of the build and it only changes when go.mod does.
COPY saas/controlplane/go.mod saas/controlplane/go.sum ./
RUN go mod download

COPY saas/controlplane/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/controlplane .

FROM alpine:3.20
RUN addgroup -S asmdb && adduser -S -G asmdb asmdb
WORKDIR /app
COPY --from=build /out/controlplane /app/controlplane
COPY site/ /app/site/
USER asmdb
EXPOSE 8080
ENTRYPOINT ["/app/controlplane"]
