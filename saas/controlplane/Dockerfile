# The ACR build context is the repository root:
#   az acr build --file saas/controlplane/Dockerfile .

# Both shipping binaries are assembled here, from the same source tree the site
# describes, so a download can never be a different build from the one the page
# is talking about. nasm -f bin emits the final image directly in both cases —
# there is no linker involved, so cross-assembling the Windows PE64 on Linux is
# not cross-compilation, it is just writing different bytes.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS binaries
RUN apk add --no-cache nasm
WORKDIR /src
COPY src/ src/
RUN set -eu; \
    nasm -f bin        -I src/ src/main.asm -o asmdb.exe; \
    nasm -f bin -dLINUX -I src/ src/main.asm -o asmdb; \
    chmod +x asmdb; \
    major=$(sed -n 's/.*%define ENGINE_MAJOR \([0-9]*\).*/\1/p' src/asmdb.inc); \
    minor=$(sed -n 's/.*%define ENGINE_MINOR \([0-9]*\).*/\1/p' src/asmdb.inc); \
    patch=$(sed -n 's/.*%define ENGINE_PATCH \([0-9]*\).*/\1/p' src/asmdb.inc); \
    version="$major.$minor.$patch"; \
    mkdir -p /out; \
    cp asmdb.exe "/out/asmdb-$version-windows-x64.exe"; \
    cp asmdb     "/out/asmdb-$version-linux-x64"; \
    printf '{\n  "version": "%s",\n  "builds": [\n' "$version" > /out/manifest.json; \
    printf '    { "os": "Windows", "arch": "x64", "format": "PE64", "file": "asmdb-%s-windows-x64.exe", "bytes": %s, "sha256": "%s" },\n' \
        "$version" "$(wc -c < asmdb.exe)" "$(sha256sum asmdb.exe | cut -d" " -f1)" >> /out/manifest.json; \
    printf '    { "os": "Linux", "arch": "x64", "format": "ELF64", "file": "asmdb-%s-linux-x64", "bytes": %s, "sha256": "%s" }\n' \
        "$version" "$(wc -c < asmdb)" "$(sha256sum asmdb | cut -d" " -f1)" >> /out/manifest.json; \
    printf '  ]\n}\n' >> /out/manifest.json; \
    cat /out/manifest.json

FROM golang:1.25-alpine@sha256:56961d79ea8129efddcc0b8643fd8a5416b4e6228cfd477e3fd61deb2672c587 AS build
WORKDIR /src

# Dependencies first, as their own layer: the Azure SDK is by far the slowest
# part of the build and it only changes when go.mod does.
COPY saas/controlplane/go.mod saas/controlplane/go.sum ./
RUN go mod download

COPY saas/controlplane/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/controlplane .

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN addgroup -S asmdb && adduser -S -G asmdb asmdb
WORKDIR /app
COPY --from=build /out/controlplane /app/controlplane
COPY site/ /app/site/
COPY --from=binaries /out/ /app/site/downloads/
USER asmdb
EXPOSE 8080
ENTRYPOINT ["/app/controlplane"]
