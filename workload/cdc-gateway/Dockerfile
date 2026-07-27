FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./

ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w -extldflags=-static" -o /out/cdc-gateway .

FROM scratch

COPY --from=build /out/cdc-gateway /cdc-gateway

# uid 100, gid 101 is the `asmdb` user the engine runs as, and the engine
# creates its data, write-ahead log and change log with mode 0600 - a
# deliberate choice, because those files contain the rows themselves and
# world-readable 0644 would leak every record to any local account.
#
# The share is Azure Files over NFS, which honours numeric POSIX ownership and
# offers no uid mapping, so a gateway running as any other uid gets
# "permission denied" on main.cdc no matter how the mount is configured.
# Matching the owner is the only way to read the log without weakening the
# engine's file mode, which is not a trade worth making.
USER 100:101
EXPOSE 8080
ENTRYPOINT ["/cdc-gateway"]
