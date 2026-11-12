# deskd's image. Needs only Docker on an arm64 host: services/scripts/build-image.sh runs it with services/ as the
# build context. It uses no BuildKit-only syntax, because a desk's Docker may not have buildx.
#
# The bases are multi-arch index digests from Docker Hub: Temurin 21.0.13+9 on Ubuntu, and Go 1.27.3 on Debian 12 for the
# bundled apps. To update one, read the docker-content-digest header of .../v2/library/<image>/manifests/<tag>.

FROM eclipse-temurin:21-jdk@sha256:ebfbb18d11ff163ee83b21258acf12248af48d22a0fdfdc68fa1a1516c05976a AS build

# mvnw needs unzip: without it the wrapper asks for the .tar.gz, and the pinned checksum is for the .zip.
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip >/dev/null

WORKDIR /build
COPY . .
RUN ./mvnw -q -DskipTests -pl deskd -am package \
    && java -Djarmode=tools -jar deskd/target/deskd.jar extract --destination /extracted


# The first-party apps deskd hosts itself until the System Engineer's app helper exists (API.md section 19, "Bundled
# apps"), each built into exactly what a package unpacks to: ma-app.json, with every file's SHA-256, size and mode, and
# files/. deskd checks them all again at start, and its own check runs on them below. build-image.sh puts each app's
# source in deskd/bundled/<name>/ from the repo's apps/; one that isn't there is skipped, so the image builds without it.
# Today that's the Bible (apps/bible), as its own build.sh lays it out: bin/bible-app, its server built static for this
# image's arch; texts/<code>/ for each translation, which must have its STATEMENT.txt and SOURCE.md; and the window's three
# files from view/, the UI/UX Engineer's. Until view/ exists the Bible is skipped too, so main still builds. GOTOOLCHAIN=local,
# so a go.mod wanting a newer Go fails here rather than fetching one.
FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS bundled

COPY deskd/docker/bundle-app.go /tools/bundle-app.go
COPY deskd/bundled/ /src/
RUN set -eu; \
    mkdir -p /out; \
    export CGO_ENABLED=0 GOFLAGS=-mod=readonly GOTOOLCHAIN=local GOCACHE=/tmp/go-cache GOPATH=/tmp/go; \
    if [ ! -f /src/bible/ma-app.json ] || [ ! -d /src/bible/server ]; then \
      echo "bundled: no apps/bible in this tree, so the image bundles no Bible"; \
      exit 0; \
    fi; \
    if [ ! -d /src/bible/view ]; then \
      echo "bundled: apps/bible has no view/ yet, so the image bundles no Bible"; \
      exit 0; \
    fi; \
    set --; \
    for f in index.html view.js view.css; do set -- "$@" -add "view/$f=/src/bible/view/$f"; done; \
    [ -d /src/bible/texts ] || { echo "bundled: apps/bible needs its texts"; exit 1; }; \
    for t in /src/bible/texts/*/; do \
      code=$(basename "$t"); \
      [ "$code" != tools ] || continue; \
      [ -f "${t}STATEMENT.txt" ] && [ -f "${t}SOURCE.md" ] || { echo "bundled: texts/$code needs STATEMENT.txt and SOURCE.md"; exit 1; }; \
      set -- "$@" -add "texts/$code=$t"; \
    done; \
    cd /src/bible/server; \
    main=$(go list -f '{{if eq .Name "main"}}{{.ImportPath}}{{end}}' ./... | sed '/^$/d'); \
    [ "$(printf '%s\n' "$main" | wc -l)" = 1 ] || { echo "bundled: apps/bible/server needs exactly one main package"; exit 1; }; \
    go build -trimpath -ldflags "-s -w" -o /tmp/bible "$main"; \
    cd /tools; \
    go run bundle-app.go -manifest /src/bible/ma-app.json -exec /tmp/bible "$@" -out /out


FROM eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a

WORKDIR /app
COPY --from=build /extracted/ /app/
COPY deskd/docker/jvm.options deskd/docker/heap-guild.options /app/

# The version comes first, then the AppCDS training, with the JVM, classpath and flags the entrypoint uses.
# - The training run can't take jvm.options' SharedArchiveFile line: the JVM refuses to read and write one file.
# - ma.cds.train runs the real deskd from boot through a session and the Browser, against stand-ins on loopback and
#   temporary Unix sockets (CdsTraining). It needs no /data, /run/desk, network or secrets, and leaves only the archive.
#   It's on this command line and nowhere else. If any step goes wrong it exits non-zero and the build fails.
# - Both runs boot deskd as root, and Files makes its tree (/data/files, under a /data of mode 0700) at start. The image
#   must carry no /data: Docker would lay that 0700 /data under the container's mounts, and uid 1100 couldn't reach
#   /data/desk or /data/files (2026.11.10-35df59e failed its smoke test that way). So it's removed, and checked gone.
# - The second run proves the archive maps, and fails the build otherwise: -Xshare:on doesn't fall back.
ARG VERSION
RUN set -eu; \
    printf 'deskd.version=%s\n' "${VERSION:?build with --build-arg VERSION=...}" > /app/deskd.properties; \
    chmod 0644 /app/jvm.options /app/heap-guild.options /app/deskd.properties; \
    grep -v '^-XX:SharedArchiveFile=' /app/jvm.options > /tmp/train.options; \
    java @/tmp/train.options -XX:ArchiveClassesAtExit=/app/deskd.jsa -Dma.cds.train=true -jar /app/deskd.jar; \
    rm -f /tmp/train.options; \
    java @/app/jvm.options -Xshare:on -Dspring.context.exit=onRefresh -jar /app/deskd.jar; \
    rm -rf /data; \
    test ! -e /data

# Root's and read-only, and after the training run, which so never sees one. Then deskd's own check of each, exactly as it
# runs at start on this arch, fails the build for one deskd wouldn't offer.
COPY --from=bundled /out/ /app/bundled-apps/
RUN java -Xshare:off -XX:TieredStopAtLevel=1 -cp /app/deskd.jar com.minimalistalliance.desk.deskd.apps.BundledApps /app/bundled-apps

USER 1100:1100

# Exec form, so the JVM is PID 1 and gets SIGTERM.
ENTRYPOINT ["java", "@/app/jvm.options", "-jar", "/app/deskd.jar"]
