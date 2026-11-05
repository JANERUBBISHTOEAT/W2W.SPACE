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
if [[ -n ${W2W_RELEASE_LOCK_FD:-} ]]; then
  # The coordinator keeps this same open file description locked for the whole
  # maintenance window. Prove it is already EX-locked; never trust a skip flag.
  python3 - "$state_root/.lock" "$W2W_RELEASE_LOCK_FD" <<'PY'
import fcntl, os, stat, sys
try:
    descriptor = int(sys.argv[2])
    if descriptor < 3 or str(descriptor) != sys.argv[2]:
        raise ValueError()
    inherited = os.fstat(descriptor)
    probe = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(probe)
        if (not stat.S_ISREG(inherited.st_mode) or inherited.st_nlink != 1 or
                inherited.st_uid != os.geteuid() or stat.S_IMODE(inherited.st_mode) & 0o077 or
                (inherited.st_dev, inherited.st_ino) != (actual.st_dev, actual.st_ino)):
            raise ValueError()
        try:
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise ValueError("The inherited description was not exclusively locked")
    finally:
        os.close(probe)
    # Only the same EX-locked description can succeed while that independent
    # SH probe is blocked. Never LOCK_UN this descriptor in a child.
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
except Exception:
    print("Error: The inherited release lock is not the protected held exclusive lock.", file=sys.stderr)
    sys.exit(1)
PY
  [[ $? == 0 ]] || fail 'Inherited release lock validation failed.'
  exec 9>&"$W2W_RELEASE_LOCK_FD"
else
  exec 9> "$state_root/.lock"
  flock -n 9 || fail 'Another W2W release/rollback is in progress.'
fi

result_file=${W2W_RELEASE_RESULT_FILE:-}
operation_token=${W2W_RELEASE_OPERATION_TOKEN:-}
result_record=
if [[ -n $result_file || -n $operation_token ]]; then
  python3 - "$state_root" "$result_file" "$operation_token" "$action" <<'PY'
import os, pathlib, re, stat, sys
try:
    root, target, token, action = sys.argv[1:]
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise ValueError()
    root = pathlib.Path(root).resolve()
    target = pathlib.Path(target)
    parent = root / ("auto-release-" + token)
    if (not target.is_absolute() or target.parent != parent or
            target.name != "update-" + action + ".json" or parent.is_symlink()):
        raise ValueError()
    info = parent.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError()
    descriptor = os.open(str(parent / "operation-token"), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) & 0o077 or stream.read() != token + "\n"):
            raise ValueError()
    if target.exists() or target.is_symlink():
        raise ValueError()
except Exception:
    print("Error: Updater results require this operation's private, token-owned transaction path.", file=sys.stderr)
    sys.exit(1)
PY
  [[ $? == 0 ]] || fail 'Invalid operation result destination.'
fi

emit_result() {
  [[ -n $result_file ]] || return 0
  python3 - "$result_file" "$operation_token" "$action" "$deploy_dir" "$result_record" "$1" <<'PY'
import json, os, pathlib, stat, sys, tempfile
temporary = None
try:
    name, token, action, directory, record_name, code = sys.argv[1:]
    target = pathlib.Path(name)
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) & 0o077 or json.loads(target.read_text()).get("operation_token") != token):
            raise ValueError()
    status = "not-created"
    if record_name:
        record = pathlib.Path(record_name)
        if record.is_symlink() or record.parent != target.parent.parent or (record / "operation-token").read_text() != token + "\n":
            raise ValueError()
        status_file = record / "status"
        status = status_file.read_text().strip() if status_file.is_file() else "preparing"
    data = {"schema": "w2w-update-result-v1", "operation_token": token, "action": action,
            "compose_directory": directory, "release_record": record_name or None,
            "status": status, "exit_code": int(code) if int(code) >= 0 else None}
    descriptor, temporary = tempfile.mkstemp(prefix=".w2w-result-", dir=str(target.parent))
    with os.fdopen(descriptor, "w") as stream:
        json.dump(data, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, str(target))
    temporary = None
    descriptor = os.open(str(target.parent), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
except Exception:
    print("Error: Could not persist the owned updater result; retain the transaction for inspection.", file=sys.stderr)
    sys.exit(1)
finally:
    if temporary is not None:
        os.unlink(temporary)
PY
}
if [[ -n $result_file ]]; then
  trap 'w2w_result_exit=$?; if ! emit_result "$w2w_result_exit"; then [[ $w2w_result_exit != 0 ]] || w2w_result_exit=1; fi; exit "$w2w_result_exit"' EXIT
  emit_result -1 || fail 'Could not initialize the updater result.'
fi

# Only the default .env beside Compose is supported. Never follow a supplied
# filename/symlink or retain a second copy of runtime secrets in release records.
persist_image() {
  python3 - "$@" <<'PY'
import os, re, stat, sys, tempfile

temporary = None
source = None
try:
    action = sys.argv[1]
    controls = {b"COMPOSE_ENV_FILES", b"COMPOSE_DISABLE_ENV_FILE", b"COMPOSE_FILE"}
    if any(name.decode() in os.environ for name in controls):
        raise ValueError("Alternate Compose environment selection is unsupported")
    source = os.open(".env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    original = os.fstat(source)
    if (not stat.S_ISREG(original.st_mode) or original.st_nlink != 1 or
            original.st_uid not in (os.geteuid(), 0) or
            not original.st_mode & stat.S_IWUSR or original.st_mode & 0o022):
        raise ValueError("Expected a protected regular .env owned by the operator")
    with os.fdopen(os.dup(source), "rb") as stream:
        contents = stream.read()
    lines = contents.splitlines(keepends=True)
    image_line = None
    for index, raw in enumerate(lines):
        line = raw[:-2] if raw.endswith(b"\r\n") else raw[:-1] if raw.endswith(b"\n") else raw
        if not line.strip() or line.lstrip().startswith(b"#"):
            continue
        assignment = re.fullmatch(rb"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)", line)
        if not assignment or assignment[1] in controls:
            raise ValueError("Unsupported dotenv assignment or Compose selector")
        value = assignment[2]
        if value[:1] in (b"'", b'"'):
            quote, escaped, closed = value[0], False, False
            for offset, byte in enumerate(value[1:], 1):
                if escaped:
                    escaped = False
                elif byte == 92:
                    escaped = True
                elif byte == quote:
                    closed = re.fullmatch(rb"[ \t]*(?:#.*)?", value[offset + 1:]) is not None
                    break
            if not closed:
                raise ValueError("Multiline dotenv values are unsupported")
        if assignment[1] == b"W2W_IMAGE":
            match = re.fullmatch(rb"([ \t]*(?:export[ \t]+)?W2W_IMAGE[ \t]*=[ \t]*)([A-Za-z0-9./:@_-]*)([ \t]*(?:#.*)?)", line)
            if image_line is not None or not match:
                raise ValueError("W2W_IMAGE must be one simple unquoted assignment")
            image_line = (index, match[1], match[3], raw[len(line):])
    if action not in ("check", "set"):
        raise ValueError("Unknown persistence action")
    if action == "set":
        image = sys.argv[2].encode("ascii")
        if not re.fullmatch(rb"(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64})", image):
            raise ValueError("Expected an immutable image reference")
        if image_line is None:
            newline = b"\r\n" if b"\r\n" in contents else b"\n"
            contents += (newline if contents and not contents.endswith(b"\n") else b"") + b"W2W_IMAGE=" + image + newline
        else:
            index, prefix, suffix, newline = image_line
            lines[index] = prefix + image + suffix + newline
            contents = b"".join(lines)
    # The preflight probes write/metadata permissions without copying secrets.
    descriptor, temporary = tempfile.mkstemp(prefix=".w2w-image-", dir=".")
    with os.fdopen(descriptor, "wb") as stream:
        current = os.fstat(stream.fileno())
        if (current.st_uid, current.st_gid) != (original.st_uid, original.st_gid):
            os.fchown(stream.fileno(), original.st_uid, original.st_gid)
        os.fchmod(stream.fileno(), stat.S_IMODE(original.st_mode))
        for name in os.listxattr(source):
            os.setxattr(stream.fileno(), name, os.getxattr(source, name))
        if action == "set":
            stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    if action == "set":
        current = os.stat(".env", follow_symlinks=False)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if identity(current) != identity(original):
            raise ValueError(".env changed during persistence")
        os.replace(temporary, ".env")
        temporary = None
        directory = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
except Exception:
    # Dotenv values, full Compose models and Python exception details can contain
    # secrets; keep diagnostics independent of their contents.
    print("Error: Cannot safely persist W2W_IMAGE; check .env type, permissions, simple assignments and Compose selectors.", file=sys.stderr)
    sys.exit(1)
finally:
    if source is not None:
        os.close(source)
    if temporary is not None:
        os.unlink(temporary)
PY
}

# Emit only the non-secret image and a hash of the remaining Compose model.
# Unsetting the shell override proves what a later ordinary Compose run selects.
compose_snapshot() {
  {
    if [[ $# == 0 ]]; then
      env -u W2W_IMAGE docker compose config --format json
    else
      W2W_IMAGE=$1 docker compose config --format json
    fi
  } | python3 -c 'import hashlib,json,sys; model=json.load(sys.stdin); image=model["services"]["remix"].pop("image"); print(image); print(hashlib.sha256(json.dumps(model,sort_keys=True,separators=(",",":")).encode()).hexdigest())'
}

compose_image_matches() {
  local expected=$1 mode=$2 snapshot
  if [[ $mode == default ]]; then snapshot=$(compose_snapshot) || return 1
  else snapshot=$(compose_snapshot "$expected") || return 1; fi
  [[ ${snapshot%%$'\n'*} == "$expected" && ${snapshot#*$'\n'} == "$compose_model" ]] || {
    printf 'Error: Compose must select the intended remix image without changing any other setting.\n' >&2
    return 1
  }
}

write_current() {
  local name=$1 value=$2 temporary
  temporary=$(mktemp "$state_root/.$name-XXXXXXXX") || return 1
  if ! printf '%s\n' "$value" > "$temporary" || ! mv -T -- "$temporary" "$state_root/$name"; then
    rm -f -- "$temporary"
    return 1
  fi
}

runtime_reference() {
  local container=$1 image_id=$2 reference
  reference=$(docker inspect --format '{{.Config.Image}}' "$container") || return 1
  if [[ $reference =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] &&
    [[ $(docker image inspect --format '{{.Id}}' "$reference") == "$image_id" ]]; then
    printf '%s\n' "$reference"
  else
    printf '%s\n' "$image_id"
  fi
}

persist_image check || fail 'Default Compose image persistence preflight failed; no application replacement was attempted.'
initial_snapshot=$(compose_snapshot)
compose_model=${initial_snapshot#*$'\n'}

verify_app() {
  local image_id=$1 expected_revision=$2 allow_legacy=$3 container
  container=$(docker compose ps -q remix) || return 1
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

select_and_verify() {
  local reference=$1 image_id=$2 expected_revision=$3 legacy=$4
  persist_image set "$reference" || return 1
  compose_image_matches "$reference" default || return 1
  env -u W2W_IMAGE docker compose up -d --no-deps --pull never --no-build remix || return 1
  verify_app "$image_id" "$expected_revision" "$legacy" || return 1
  compose_image_matches "$reference" default || return 1
  write_current current-image "$reference" || return 1
}

rollback_record() {
  local record=$1 previous_image previous_revision previous_reference candidate legacy=false
  [[ -d $record && -f $record/previous-image && -f $record/previous-revision && -f $record/compose-directory ]] || return 1
  [[ $(cat "$record/compose-directory") == "$deploy_dir" ]] || return 1
  previous_image=$(cat "$record/previous-image") || return 1
  previous_revision=$(cat "$record/previous-revision") || return 1
  [[ $previous_image =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  docker image inspect "$previous_image" >/dev/null || return 1
  previous_reference=$previous_image
  if [[ -f $record/previous-reference ]]; then
    candidate=$(cat "$record/previous-reference") || return 1
    if [[ $candidate =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] &&
      [[ $(docker image inspect --format '{{.Id}}' "$candidate") == "$previous_image" ]]; then
      previous_reference=$candidate
    fi
  fi
  [[ $previous_revision =~ ^[0-9a-f]{40}$ ]] || legacy=true
  compose_image_matches "$previous_reference" override || return 1
  printf 'rollback-pending\n' > "$record/status" || return 1
  if ! select_and_verify "$previous_reference" "$previous_image" "$previous_revision" "$legacy"; then
    printf 'rollback-failed\n' > "$record/status"
    return 2
  fi
  printf 'rolled-back\n' > "$record/status" || return 1
  printf 'Rollback verified against previous image ID: %s\n' "$previous_image"
  if [[ $legacy == true ]]; then
    printf 'Legacy image: homepage passed; version endpoint unavailable, exact container image ID verified.\n'
  fi
}

if [[ $action == rollback ]]; then
  [[ ${3:-} == /* ]] || fail 'Provide the exact absolute release record directory.'
  if [[ -n $operation_token ]]; then
    [[ -f $3/operation-token && $(cat "$3/operation-token") == "$operation_token" ]] || fail 'Rollback record does not belong to this operation.'
    result_record=$3
    emit_result -1 || fail 'Could not identify the owned rollback record.'
  fi
  recovery_container=$(docker compose ps -q remix)
  [[ -n $recovery_container ]] || fail 'The running app is required before coordinated rollback.'
  recovery_image=$(docker inspect --format '{{.Image}}' "$recovery_container")
  [[ $recovery_image =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Invalid current runtime image ID.'
  recovery_reference=$(runtime_reference "$recovery_container" "$recovery_image")
  recovery_revision=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.revision"}}{{end}}' "$recovery_image")
  recovery_legacy=false
  [[ $recovery_revision =~ ^[0-9a-f]{40}$ ]] || recovery_legacy=true
  if rollback_record "$3"; then
    :
  else
    rollback_status=$?
    [[ $rollback_status == 2 ]] || fail 'Rollback prerequisites or record update failed; inspect the release record before recovery.'
    printf 'Rollback failed; attempting to restore the pre-rollback application and its default image.\n' >&2
    if select_and_verify "$recovery_reference" "$recovery_image" "$recovery_revision" "$recovery_legacy"; then
      printf 'rollback-failed-restored\n' > "$3/status"
      fail 'Rollback failed; the pre-rollback image and default were restored. Retain the record.'
    fi
    fail 'Rollback and recovery are incomplete; inspect the record, default Compose image and running app.'
  fi
  exit 0
fi

release_image=${3:-}
revision=${4:-}
[[ $release_image =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] || fail 'An immutable image digest is required.'
[[ $revision =~ ^[0-9a-f]{40}$ ]] || fail 'A full verified commit SHA is required.'
compose_image_matches "$release_image" override || fail 'Compose image selection preflight failed.'
app_container=$(docker compose ps -q remix)
redis_container=$(docker compose ps -q redis)
[[ -n $app_container && -n $redis_container ]] || fail 'Existing remix and redis containers are required; first-time provisioning is a separate operation.'
previous_image=$(docker inspect --format '{{.Image}}' "$app_container")
[[ $previous_image =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Invalid previous runtime image ID.'
previous_reference=$(runtime_reference "$app_container" "$previous_image")
previous_revision=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.revision"}}{{end}}' "$previous_image")
redis_image=$(docker inspect --format '{{.Image}}' "$redis_container")

docker pull "$release_image"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$release_image") == "$revision" ]] || fail 'Published image revision does not match the verified commit.'
target_image=$(docker image inspect --format '{{.Id}}' "$release_image")
record=$(mktemp -d "$state_root/release-${revision:0:12}-XXXXXXXX")
if [[ -n $operation_token ]]; then
  printf '%s\n' "$operation_token" > "$record/operation-token"
  result_record=$record
  emit_result -1 || fail 'Could not identify the newly created release record.'
fi
printf '%s\n' "$deploy_dir" > "$record/compose-directory"
printf '%s\n' "$previous_image" > "$record/previous-image"
printf '%s\n' "$previous_reference" > "$record/previous-reference"
printf '%s\n' "$previous_revision" > "$record/previous-revision"
docker image inspect --format '{{json .RepoDigests}}' "$previous_image" > "$record/previous-repository-digests.json"
printf '%s\n' "$release_image" > "$record/release-image"
printf '%s\n' "$revision" > "$record/release-revision"
printf '%s\n' "$redis_image" > "$record/redis-image"
printf 'backup-pending\n' > "$record/status"
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

printf 'release-pending\n' > "$record/status"
if ! select_and_verify "$release_image" "$target_image" "$revision" false ||
  ! write_current current-release-record "$record"; then
  printf 'Rollout failed; restoring the recorded application image.\n' >&2
  rollback_record "$record" || fail 'Automatic rollback is incomplete; inspect the release record, default image and running app before recovery.'
  exit 1
fi
printf 'released\n' > "$record/status"
printf 'Application image and health version verified: %s\n' "$revision"
printf 'Redis and proxy services were not replaced. Verify the public HTTPS endpoint next.\n'
