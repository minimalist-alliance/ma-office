# desk-agent's image, in deskd's style. Needs only Docker on an arm64 host: services/scripts/build-image.sh runs it with
# services/ as the build context. It uses no BuildKit-only syntax, because a desk's Docker may not have buildx.
#
# Both bases are the multi-arch index digests deskd pins, Temurin 21.0.13+9 on Ubuntu, so the two services share
# their layers on a desk. To update them, read the docker-content-digest header of
# .../v2/library/eclipse-temurin/manifests/<tag>, and move deskd's in the same change.

FROM eclipse-temurin:21-jdk@sha256:ebfbb18d11ff163ee83b21258acf12248af48d22a0fdfdc68fa1a1516c05976a AS build

# mvnw needs unzip: without it the wrapper asks for the .tar.gz, and the pinned checksum is for the .zip.
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip >/dev/null

WORKDIR /build
COPY . .
# A module of services/pom.xml, built as deskd is.
RUN ./mvnw -q -DskipTests -pl desk-agent -am package \
    && java -Djarmode=tools -jar desk-agent/target/desk-agent.jar extract --destination /extracted

# SQLite's native library for this machine's architecture, out of the jar ahead of time. Left to itself, sqlite-jdbc
# extracts it into /tmp at each start, and in the container /tmp is a tmpfs Docker mounts noexec, where it can't load.
RUN mkdir /extracted/native \
    && unzip -q -j -d /extracted/native /extracted/lib/sqlite-jdbc-*.jar \
      "org/sqlite/native/Linux/$(uname -m)/libsqlitejdbc.so"


FROM eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a

WORKDIR /app
COPY --from=build /extracted/ /app/
COPY desk-agent/docker/jvm.options /app/jvm.options

# The version comes first, then the AppCDS training, with the JVM, classpath and flags the entrypoint uses.
# - The training run can't take jvm.options' SharedArchiveFile line: the JVM refuses to read and write one file.
# - ma.cds.train runs the real desk-agent from boot through a key, an answer, a limit and the audit chain, against a
#   stand-in provider, in a temporary directory (CdsTraining). It needs no /data, /run/desk-agent, network or secrets,
#   leaves only the archive, and fails if SQLite's library didn't load from /app/native. It's on this command line
#   and nowhere else. If any step goes wrong it exits non-zero and the build fails.
# - The second run proves the archive maps, and fails the build otherwise: -Xshare:on doesn't fall back.
ARG VERSION
RUN set -eu; \
    printf 'desk.agent.version=%s\n' "${VERSION:?build with --build-arg VERSION=...}" > /app/desk-agent.properties; \
    chmod 0644 /app/jvm.options /app/desk-agent.properties /app/native/libsqlitejdbc.so; \
    grep -v '^-XX:SharedArchiveFile=' /app/jvm.options > /tmp/train.options; \
    java @/tmp/train.options -XX:ArchiveClassesAtExit=/app/desk-agent.jsa -Dma.cds.train=true -jar /app/desk-agent.jar; \
    rm -f /tmp/train.options; \
    java @/app/jvm.options -Xshare:on -Dspring.context.exit=onRefresh -jar /app/desk-agent.jar

USER 1103:1103

# Exec form, so the JVM is PID 1 and gets SIGTERM.
ENTRYPOINT ["java", "@/app/jvm.options", "-jar", "/app/desk-agent.jar"]
