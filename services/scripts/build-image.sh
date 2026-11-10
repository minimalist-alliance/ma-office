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
else
  docker build --network host --file "$dockerfile" --build-arg "VERSION=$tag" --tag "ma/$component:$tag" "$services_dir"
fi
echo "build-image: built ma/$component:$tag"
