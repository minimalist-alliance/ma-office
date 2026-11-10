# desk-notebook's image: Node 24 and one file, the bundle. services/scripts/build-image.sh runs it with a context of only
# services/notebook/ and web/notebook/src/model/, because the service bundles the model as source. It uses no
# BuildKit-only syntax, because a desk's Docker may not have buildx.
#
# Multi-arch: the base is the multi-arch index digest of node:24-bookworm-slim, as the spike pinned it, so this builds on
# arm64 (desks) and amd64 (self-hosted). The bundle is JavaScript with no native addons, and esbuild's own binary comes
# from the platform's optional package, which npm ci picks. To update the base, read the docker-content-digest header of
# .../v2/library/node/manifests/24-bookworm-slim.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

WORKDIR /build
COPY web/notebook/src/model/ web/notebook/src/model/
COPY services/notebook/package.json services/notebook/package-lock.json services/notebook/
COPY services/notebook/scripts/bundle.mjs services/notebook/scripts/bundle.mjs
COPY services/notebook/src/ services/notebook/src/
# No install scripts: nothing here needs one, esbuild's only checks its binary, and no package gets to run code.
RUN cd services/notebook \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && node scripts/bundle.mjs \
    && test -s dist/desk-notebook.mjs

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG VERSION
ENV DESK_NOTEBOOK_VERSION=${VERSION}
WORKDIR /app
COPY --from=build /build/services/notebook/dist/desk-notebook.mjs /app/desk-notebook.mjs
RUN set -eu; \
    : "${VERSION:?build with --build-arg VERSION=...}"; \
    chmod 0644 /app/desk-notebook.mjs; \
    node --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(":memory:"); d.exec("CREATE VIRTUAL TABLE f USING fts5(a, tokenize = \"unicode61 remove_diacritics 2\", prefix = \"2 3\")"); d.close(); require("node:zlib").zstdCompressSync("x"); new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" });'

USER 1105:1105

# Exec form, so Node is PID 1 and gets SIGTERM. docker/run gives the flags; these are the same, for anyone running it bare.
ENTRYPOINT ["node"]
CMD ["--max-old-space-size=192", "--disable-warning=ExperimentalWarning", "/app/desk-notebook.mjs"]
