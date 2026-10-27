#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run via deploy-auto.sh after coordination, or explicitly on the confirmed host.
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
action=${1:-help}
if [[ $action == help || $action == --help || $action == -h ]]; then
  printf 'Usage: update.sh release ABSOLUTE_COMPOSE_DIR IMAGE_DIGEST COMMIT_SHA\n       update.sh rollback ABSOLUTE_COMPOSE_DIR ABSOLUTE_RELEASE_RECORD\n'
  exit 0
fi
[[ $action == release || $action == rollback ]] || fail 'Unknown action.'
[[ ${W2W_RELEASE_APPROVED:-} == 1 ]] || fail 'A coordinated server change requires W2W_RELEASE_APPROVED=1.'
deploy_dir=${2:-}
[[ $deploy_dir == /* && -d $deploy_dir ]] || fail 'Provide the discovered absolute Compose directory.'
cd "$deploy_dir"
for command in docker python3 flock sha256sum; do command -v "$command" >/dev/null || fail "Missing required command: $command"; done
docker compose version >/dev/null
state_root=${W2W_RELEASE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/w2w-releases}
[[ $state_root == /* ]] || fail 'Release state directory must be absolute.'
mkdir -p "$state_root"
exec 9> "$state_root/.lock"
flock -n 9 || fail 'Another W2W release/rollback is in progress.'

compose_image_matches() {
  local actual
  actual=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["remix"]["image"])')
  [[ $actual == "$W2W_IMAGE" ]] || fail 'Compose remix.image must use W2W_IMAGE; review the remote Compose file first.'
}

verify_app() {
  local image_id=$1 expected_revision=$2 allow_legacy=$3 container
  container=$(docker compose ps -q remix)
  [[ -n $container && $(docker inspect --format '{{.Image}}' "$container") == "$image_id" ]] || return 1
  docker exec "$container" node --input-type=module -e '
    const [revision, legacy] = process.argv.slice(1);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:3000/health", {signal: AbortSignal.timeout(3000)});
        if (response.ok) {
          // Older apps can redirect /health to a successful HTML homepage.
          const health = await response.json().catch(() => null);
          if (health?.status === "ok" && health.version === revision) process.exit(0);
        }
        if (legacy === "true") {
          const home = await fetch("http://127.0.0.1:3000/", {signal: AbortSignal.timeout(3000)});
          if (home.ok && (await home.text()).includes("id=\"sidebar\"")) process.exit(0);
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.error("Application health/version verification failed");
    process.exit(1);
  ' "$expected_revision" "$allow_legacy"
}

rollback_record() {
  local record=$1 previous_image previous_revision legacy=false
  [[ -d $record && -f $record/previous-image && -f $record/compose-directory ]] || fail 'Release record is incomplete.'
  [[ $(cat "$record/compose-directory") == "$deploy_dir" ]] || fail 'Release record belongs to a different Compose directory.'
  previous_image=$(cat "$record/previous-image")
  previous_revision=$(cat "$record/previous-revision")
  [[ $previous_image =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Invalid recorded previous image ID.'
  docker image inspect "$previous_image" >/dev/null || fail 'Previous image is unavailable; recover its recorded registry digest/archive before rollback.'
  [[ $previous_revision =~ ^[0-9a-f]{40}$ ]] || legacy=true
  export W2W_IMAGE=$previous_image
  compose_image_matches
  docker compose up -d --no-deps --pull never --no-build remix
  verify_app "$previous_image" "$previous_revision" "$legacy" || fail 'Rollback started but its health verification failed; inspect only the app service.'
  printf '%s\n' "$previous_image" > "$state_root/current-image"
  printf 'Rollback verified against previous image ID: %s\n' "$previous_image"
  if [[ $legacy == true ]]; then
    printf 'Legacy image: homepage passed; version endpoint unavailable, exact container image ID verified.\n'
  fi
}

if [[ $action == rollback ]]; then
  [[ ${3:-} == /* ]] || fail 'Provide the exact absolute release record directory.'
  rollback_record "$3"
  exit 0
fi

release_image=${3:-}
revision=${4:-}
[[ $release_image =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] || fail 'An immutable image digest is required.'
[[ $revision =~ ^[0-9a-f]{40}$ ]] || fail 'A full verified commit SHA is required.'
export W2W_IMAGE=$release_image
compose_image_matches
app_container=$(docker compose ps -q remix)
redis_container=$(docker compose ps -q redis)
[[ -n $app_container && -n $redis_container ]] || fail 'Existing remix and redis containers are required; first-time provisioning is a separate operation.'
previous_image=$(docker inspect --format '{{.Image}}' "$app_container")
previous_revision=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.revision"}}{{end}}' "$previous_image")
redis_image=$(docker inspect --format '{{.Image}}' "$redis_container")

docker pull "$release_image"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$release_image") == "$revision" ]] || fail 'Published image revision does not match the verified commit.'
target_image=$(docker image inspect --format '{{.Id}}' "$release_image")
record=$(mktemp -d "$state_root/release-${revision:0:12}-XXXXXXXX")
printf '%s\n' "$deploy_dir" > "$record/compose-directory"
printf '%s\n' "$previous_image" > "$record/previous-image"
printf '%s\n' "$previous_revision" > "$record/previous-revision"
docker image inspect --format '{{json .RepoDigests}}' "$previous_image" > "$record/previous-repository-digests.json"
printf '%s\n' "$release_image" > "$record/release-image"
printf '%s\n' "$revision" > "$record/release-revision"
printf '%s\n' "$redis_image" > "$record/redis-image"
docker image tag "$previous_image" "w2w-rollback:$(basename "$record")"
printf 'Release record (retain for rollback): %s\n' "$record"

# Capture and validate a consistent RDB without changing Redis configuration.
# Authentication, if required, must already be configured securely in redis-cli.
backup_path="/tmp/w2w-$(basename "$record").rdb"
docker exec "$redis_container" redis-cli --rdb "$backup_path"
docker exec "$redis_container" redis-check-rdb "$backup_path" >/dev/null
docker cp "$redis_container:$backup_path" "$record/redis.rdb"
docker exec "$redis_container" rm -- "$backup_path"
[[ -s $record/redis.rdb ]] || fail 'Redis backup is empty.'
chmod 600 "$record/redis.rdb"
sha256sum "$record/redis.rdb" > "$record/redis.rdb.sha256"

# Rehearse restore using the existing Redis image, no network and a read-only
# backup mount. Never mount or replace the production Redis volume here.
docker run --rm --pull never --network none \
  --mount "type=bind,src=$record/redis.rdb,dst=/data/dump.rdb,readonly" \
  "$redis_image" sh -ec '
    redis-check-rdb /data/dump.rdb >/dev/null
    redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" \
      --port 0 --unixsocket /tmp/w2w-restore.sock --daemonize yes --logfile /tmp/w2w-restore.log
    trap "redis-cli -s /tmp/w2w-restore.sock shutdown nosave >/dev/null 2>&1 || true" EXIT
    for attempt in $(seq 1 60); do
      if redis-cli -s /tmp/w2w-restore.sock ping 2>/dev/null | grep -qx PONG; then
        printf "Backup restore verified; database 0 key count: "
        redis-cli -s /tmp/w2w-restore.sock dbsize
        exit 0
      fi
      sleep 1
    done
    exit 1
  '

if ! docker compose up -d --no-deps --pull never --no-build remix ||
  ! verify_app "$target_image" "$revision" false; then
  printf 'Rollout failed; restoring the recorded application image.\n' >&2
  rollback_record "$record"
  exit 1
fi
printf '%s\n' "$release_image" > "$state_root/current-image"
printf '%s\n' "$record" > "$state_root/current-release-record"
printf 'Application image and health version verified: %s\n' "$revision"
printf 'Redis and proxy services were not replaced. Verify the public HTTPS endpoint next.\n'
