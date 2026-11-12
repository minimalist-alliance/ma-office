#!/usr/bin/env bash
# Builds a service's image and leaves it in the local Docker daemon as ma/<component>:<tag>.
#
#   services/scripts/build-image.sh <service> <tag>
#
# <service> is the directory under services/. Its component is the same name, except notebook, which is desk-notebook.
# Needs Docker on an arm64 host: the image's AppCDS training runs during the build, on the JVM the image ships.
# notebook has no JVM, so it builds on amd64 too (self-hosted desks).
# Build steps use host networking because a desk's Docker has its firewall management off (ADR 0040), which leaves
# a bridge with no way out.
#
# deskd's context is services/ plus deskd/bundled/<name>/ for each first-party app it bundles (deskd/docs/API.md section 19,
# "Bundled apps"), copied from the repo's apps/ when this tree has the app: today apps/bible, without its dev view, its
# own build's dist/ or node_modules. MA_BUNDLED_APPS_DIR names another apps/ (tests). The context goes to Docker as a stream, so nothing is
# written into the tree.
set -euo pipefail

die() { echo "build-image: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: build-image.sh <service> <tag>"
service=$1
tag=$2
# The same rules as Platform's desk-service-release.sh, so a tag that builds can also be published.
[[ $service =~ ^[a-z][a-z0-9-]{1,31}$ ]] || die "bad service name: $service"
[[ $tag =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad tag: $tag"

case $service in
  notebook) component=desk-notebook ;;
  *) component=$service ;;
esac

services_dir=$(cd "$(dirname "$0")/.." && pwd)
dockerfile=$services_dir/$service/Dockerfile
[ -f "$dockerfile" ] || die "no Dockerfile for $service: $dockerfile"

command -v docker >/dev/null || die "docker is not installed"
arch=$(docker info --format '{{.Architecture}}') || die "can't reach the Docker daemon"
case $arch in
  aarch64 | arm64) ;;
  x86_64 | amd64) [ "$service" = notebook ] || die "needs an arm64 Docker daemon, this one is $arch" ;;
  *) die "needs an arm64 Docker daemon, this one is $arch" ;;
esac

if [ "$service" = notebook ]; then
  # It bundles web/notebook/src/model as source, so its context is those paths and its own, from the repo's root.
  (cd "$services_dir/.." && tar --exclude=node_modules --exclude=dist -cf - services/notebook web/notebook/src/model) |
    docker build --network host --file services/notebook/Dockerfile --build-arg "VERSION=$tag" --tag "ma/$component:$tag" -
elif [ "$service" = deskd ]; then
  apps_dir=${MA_BUNDLED_APPS_DIR:-$services_dir/../apps}
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  mkdir -p "$stage/deskd/bundled"
  if [ -f "$apps_dir/bible/ma-app.json" ] && [ -d "$apps_dir/bible/server" ]; then
    (cd "$apps_dir" && tar --exclude=node_modules --exclude=view-dev --exclude=.git --exclude=bible/dist -cf - bible) |
      tar -C "$stage/deskd/bundled" -xf -
    echo "build-image: bundling the Bible from $apps_dir/bible"
  else
    echo "build-image: no apps/bible here, so the image bundles no Bible"
  fi
  # As .dockerignore has it for a directory context: no local build output.
  tar --exclude=target --exclude=node_modules -cf - -C "$services_dir" . -C "$stage" deskd/bundled |
    docker build --network host --file deskd/Dockerfile --build-arg "VERSION=$tag" --tag "ma/$component:$tag" -
else
  docker build --network host --file "$dockerfile" --build-arg "VERSION=$tag" --tag "ma/$component:$tag" "$services_dir"
fi
echo "build-image: built ma/$component:$tag"
