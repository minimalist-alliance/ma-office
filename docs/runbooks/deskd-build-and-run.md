# deskd: build, publish, run, roll back

How `deskd` goes from a commit to a desk. Format and rules: [`desk-runtime.md`](../interfaces/desk-runtime.md) sections 5 and 6, and [ADR 0040](../decisions/0040-desk-services-spring-boot-docker.md).

**State, 2026-11-06:** `build-on-box.sh` has built every release since 2026-11-05 on the arm64 box. `2026.11.06-1599b0c` took about 1.5 minutes there with the base images cached, and was published and rolled to the test desk as below, as were `2026.11.06-4919e5d` (about 2 minutes) and `2026.11.06-4781fc1` after it. `build-on-box.sh <sha> desk-agent` (or `notebook`, whose component is `desk-notebook`) builds those the same way; both have been baked since (`image/RELEASES.md`). `services/scripts/test-release-scripts.sh` covers the scripts here with a stub `docker`, and the JVM steps on x86_64.

## Build
From the dev machine, with a commit that exists locally:
```sh
services/scripts/build-on-box.sh <git-sha> [service]      # deskd by default
# The scripts read BUILD_INSTANCE (the build box) and ARTIFACT_BUCKET from the environment, or from the private file `~/work/desk-build.env` (or `$DESK_BUILD_ENV`) on the release machine; the values are never in this repo.
```
- It uploads a `git archive` of the commit to 
`s3://$ARTIFACT_BUCKET/desk/deskd/build/<version>/`, starts the test box 
(`$BUILD_INSTANCE`) if it's stopped, and has the box build and package over SSM, using presigned URLs only. The box stops itself after 60 idle minutes.
- It prints the end of the build log and the artifact's path: `~/.local/share/ma-desk-releases/deskd/<version>/deskd-<version>.tgz`, with its `.sha256`. Then it deletes its S3 objects under `build/`.
- The version is `<commit date in UTC>-<sha7>`, such as `2026.11.05-a72fc48`. A commit always gets the same version.
- If the build fails, the full log is on the box at `/var/tmp/ma-build-deskd.log`. If the disk is full, run `docker system prune -af` there over SSM.

On any arm64 host with Docker and a checkout, do the same by hand. The image stays in the local daemon as `ma/deskd:<tag>`:
```sh
services/scripts/build-image.sh deskd <tag>
services/scripts/package-release.sh deskd <tag> <outdir>
```

The Dockerfile's build already proves the AppCDS archive maps. To check it again, for example after `docker load`, run this. Exit 0 means it mapped:
```sh
docker run --rm --entrypoint java <image> @/app/jvm.options -Xshare:on -Dspring.context.exit=onRefresh -jar /app/deskd.jar
```

To update the base images, read the new digests as the Dockerfile's header says, change both, and use a new commit. Artifacts are immutable.

## Publish and roll out
These are Platform's scripts, run from `~/minimalist-alliance` as `claude-agent`. See its `docs/runbooks/desk-rollout.md`.
```sh
scripts/desk-service-release.sh publish deskd <path>/deskd-<version>.tgz <version>
scripts/desk-service-release.sh rollout deskd <version> test
scripts/desk-service-release.sh rollout deskd <version> <prod-target>      # the script's non-test target, in its usage line; only after test passed; snapshots the data volume first
```
The same artifact goes to the test desk and then to the owner's, never a rebuild. The desk must be running with SSM online.

**Before publishing, the release checklist:**
- **The simplified view's sensitive-site list** (`browser/minified/sensitive-sites.txt`, 82 entries at task 47, Security's open item): read every entry against what it should hold (webmail, password managers, banks, brokerages, exchanges, payments, identity, health), add what's missing, drop what's dead, and say in the release notes that it was reviewed. It ships in the jar, unsigned and not updated on its own, so a release is the only time it changes.

## What `ma-update` does
`ma-update deskd <url> <sha256>`, as root over SSM (`image/recipe/files/opt/ma/bin/ma-update`):
1. Downloads the artifact, checks its hash and unpacks it to `/opt/ma/deskd/releases/<version>`.
2. Runs `docker load` on `image.tar`, writes the image's ID to `image-id` and deletes `image.tar`.
3. Moves `previous` to the old release and `current` to the new one, and restarts `deskd.service`, whose `ExecStart` is `current/run`.
4. Runs `/opt/ma/smoke-test` for up to 90 s. For `deskd` that's `current/health`: `GET /health` on `/run/desk/deskd-admin.sock` must answer 200.
5. If healthy, prunes old releases and images. If not, puts the old release back, restarts it and exits 1.

## Roll back
```sh
scripts/desk-service-release.sh rollback deskd test      # or <prod-target>
```
On the desk, that's `/opt/ma/bin/ma-update deskd --rollback`. It swaps `current` and `previous` and restarts. It never touches `/data`, which is why schema changes must be expand-then-contract.

## Logs and health
On the desk, as root over SSM. The journal is volatile, so logs end at the next stop.
```sh
journalctl -t deskd -n 100 --no-pager                    # deskd's own output
journalctl -u deskd -n 50 --no-pager                     # the unit: starts, stops, docker errors
/opt/ma/deskd/current/health; echo $?                    # 0 means healthy
curl -s --unix-socket /run/desk/deskd-admin.sock http://localhost/health    # version, rtc link, platform link
docker inspect -f '{{.State.Status}} {{.State.OOMKilled}}' deskd
```
`/health` is 503 only if `deskd` can't write `/data/desk`. A lost link to `desk-rtc` or Platform still answers 200, and shows in the body.
