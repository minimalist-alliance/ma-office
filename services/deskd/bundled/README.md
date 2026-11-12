# Bundled apps: the build's staging place

Empty in git. `services/scripts/build-image.sh` puts each first-party app deskd bundles here, as `bundled/<name>/`, from the
repo's `apps/` (today `apps/bible`, without its dev view), in the stream it sends Docker, never on disk. The Dockerfile's
`bundled` stage builds each one into `/app/bundled-apps/<id>/` with `docker/bundle-app.go`, and skips one that isn't here,
so a plain `docker build -f deskd/Dockerfile services` builds an image with none. What deskd does with them: `docs/API.md`
section 19, "Bundled apps".
