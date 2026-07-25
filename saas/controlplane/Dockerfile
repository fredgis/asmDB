FROM golang:1.25-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
COPY saas/controlplane/ ./
# go mod tidy resolves and pins the Azure SDK inside the build, so the tree does
# not have to carry a go.sum that no toolchain on the authoring machine could
# have generated.
RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/controlplane .

FROM alpine:3.20
RUN addgroup -S asmdb && adduser -S -G asmdb asmdb
WORKDIR /app
COPY --from=build /out/controlplane /app/controlplane
COPY site/ /app/site/
USER asmdb
EXPOSE 8080
ENTRYPOINT ["/app/controlplane"]
