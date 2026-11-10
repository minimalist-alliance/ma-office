#!/usr/bin/env bash
# Packages a built image as a release artifact (desk-runtime.md section 6), for Platform's desk-service-release.sh.
#
#   services/scripts/package-release.sh <service> <tag> <outdir>
#
# Writes <outdir>/<component>-<tag>.tgz and <component>-<tag>.tgz.sha256 beside it. At the archive's root: VERSION, run,
# health, <component>.env and image.tar (docker save of ma/<component>:<tag>). Run build-image.sh first. <service> is the
# directory under services/, and its component is the same name, except notebook, which is desk-notebook.
set -euo pipefail
umask 022

die() { echo "package-release: $*" >&2; exit 1; }

[ $# -eq 3 ] || die "usage: package-release.sh <service> <tag> <outdir>"
service=$1
tag=$2
outdir=$3
[[ $service =~ ^[a-z][a-z0-9-]{1,31}$ ]] || die "bad service name: $service"
[[ $tag =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad tag: $tag"

case $service in
  notebook) component=desk-notebook ;;
  *) component=$service ;;
esac

docker_dir=$(cd "$(dirname "$0")/.." && pwd)/$service/docker
for file in run health "$component.env"; do
  [ -f "$docker_dir/$file" ] || die "missing $docker_dir/$file"
done

command -v docker >/dev/null || die "docker is not installed"
image=ma/$component:$tag
docker image inspect "$image" >/dev/null 2>&1 || die "no local image $image: run build-image.sh first"

mkdir -p "$outdir"
outdir=$(cd "$outdir" && pwd)
# Beside the output and not in /tmp, which may be a small tmpfs: image.tar is hundreds of MiB.
stage=$(mktemp -d "$outdir/.package-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT

mkdir "$stage/root"
printf '%s\n' "$tag" >"$stage/root/VERSION"
install -m 0755 "$docker_dir/run" "$docker_dir/health" "$stage/root/"
install -m 0644 "$docker_dir/$component.env" "$stage/root/"
docker save -o "$stage/root/image.tar" "$image"
[ -s "$stage/root/image.tar" ] || die "docker save wrote nothing"
chmod 0644 "$stage/root/image.tar"

name=$component-$tag.tgz
tar -C "$stage/root" --owner=0 --group=0 --numeric-owner -czf "$stage/$name" \
  VERSION run health "$component.env" image.tar
(cd "$stage" && sha256sum "$name" >"$name.sha256")

# The checksum moves last, so a .sha256 beside a .tgz always means a finished one.
rm -f "$outdir/$name.sha256"
mv -f "$stage/$name" "$outdir/$name"
mv -f "$stage/$name.sha256" "$outdir/$name.sha256"
echo "package-release: $outdir/$name"
