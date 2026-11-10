# deskd's image. Needs only Docker on an arm64 host: services/scripts/build-image.sh runs it with services/ as the
# build context. It uses no BuildKit-only syntax, because a desk's Docker may not have buildx.
#
# Both bases are multi-arch index digests from Docker Hub, Temurin 21.0.13+9 on Ubuntu. To update them, read the
# docker-content-digest header of .../v2/library/eclipse-temurin/manifests/<tag>.

FROM eclipse-temurin:21-jdk@sha256:ebfbb18d11ff163ee83b21258acf12248af48d22a0fdfdc68fa1a1516c05976a AS build

# mvnw needs unzip: without it the wrapper asks for the .tar.gz, and the pinned checksum is for the .zip.
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip >/dev/null

WORKDIR /build
COPY . .
RUN ./mvnw -q -DskipTests -pl deskd -am package \
    && java -Djarmode=tools -jar deskd/target/deskd.jar extract --destination /extracted


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

USER 1100:1100

# Exec form, so the JVM is PID 1 and gets SIGTERM.
ENTRYPOINT ["java", "@/app/jvm.options", "-jar", "/app/deskd.jar"]
