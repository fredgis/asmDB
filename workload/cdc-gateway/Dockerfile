FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./

ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w -extldflags=-static" -o /out/cdc-gateway .

FROM scratch

COPY --from=build /out/cdc-gateway /cdc-gateway

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/cdc-gateway"]
