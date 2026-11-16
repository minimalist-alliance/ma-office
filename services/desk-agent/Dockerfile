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
# The parse sidecar's worker (ADR 0097): its sandbox, on this image, runs java @/app/parse.options per attached file.
COPY desk-agent/docker/parse.options /app/parse.options
# desk-parse's Courier mode (ADR 0097, draft ADR "Courier's store" section 4): the Courier sandbox runs
# java @/app/courier-parse.options per message for deskd. /app/courier/trackers.txt is an empty placeholder the sandbox
# mounts the image's tracker list over (ADR 0076's pinned lists).
COPY desk-agent/docker/courier-parse.options /app/courier-parse.options

# The version comes first, then the AppCDS training, with the JVM, classpath and flags the entrypoint uses.
# - The training run can't take jvm.options' SharedArchiveFile line: the JVM refuses to read and write one file.
# - ma.cds.train runs the real desk-agent from boot through a key, an answer, a limit and the audit chain, against a
#   stand-in provider, in a temporary directory (CdsTraining). It needs no /data, /run/desk-agent, network or secrets,
#   leaves only the archive, and fails if SQLite's library didn't load from /app/native. It's on this command line
#   and nowhere else. If any step goes wrong it exits non-zero and the build fails.
# - The second run proves the archive maps, and fails the build otherwise: -Xshare:on doesn't fall back.
# - The last two read a line of text through /app/parse.options and a message through /app/courier-parse.options, as the
#   sandboxes would, and fail the build without their text.
ARG VERSION
RUN set -eu; \
    printf 'desk.agent.version=%s\n' "${VERSION:?build with --build-arg VERSION=...}" > /app/desk-agent.properties; \
    mkdir -p /app/courier; : > /app/courier/trackers.txt; \
    chmod 0755 /app/courier; \
    chmod 0644 /app/jvm.options /app/parse.options /app/courier-parse.options /app/courier/trackers.txt /app/desk-agent.properties /app/native/libsqlitejdbc.so; \
    grep -v '^-XX:SharedArchiveFile=' /app/jvm.options > /tmp/train.options; \
    java @/tmp/train.options -XX:ArchiveClassesAtExit=/app/desk-agent.jsa -Dma.cds.train=true -jar /app/desk-agent.jar; \
    rm -f /tmp/train.options; \
    java @/app/jvm.options -Xshare:on -Dspring.context.exit=onRefresh -jar /app/desk-agent.jar; \
    printf 'parse1 text 1000 1\nthe parse sidecar reads\n' | env -i "$(command -v java)" @/app/parse.options | grep -qx 'the parse sidecar reads'; \
    printf 'courier1 message\nFrom: build@example.com\nSubject: build\n\nthe courier mode reads\n' \
      | env -i "$(command -v java)" @/app/courier-parse.options > /tmp/courier.out; \
    head -n 1 /tmp/courier.out | grep -qx 'OK'; grep -q 'the courier mode reads' /tmp/courier.out; rm -f /tmp/courier.out

USER 1103:1103

# Exec form, so the JVM is PID 1 and gets SIGTERM.
ENTRYPOINT ["java", "@/app/jvm.options", "-jar", "/app/desk-agent.jar"]
