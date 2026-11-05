#!/usr/bin/env bash
set -euo pipefail

# Publishing and server changes use separate invocations, including in CI.
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
action=${1:-help}
image_repository=${W2W_IMAGE_REPOSITORY:-zheyuanwei/w2w}
deploy_target=${DEPLOY_SERVER:-}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: ./deploy-auto.sh verify|build|publish|release|rollback
  verify   Require a clean checkout; install, typecheck, lint, test and build.
  build    Run verify, then build/load the linux/amd64 image tagged by full HEAD.
  publish  Push the verified local image; print its immutable registry digest.
  release  Deploy the immutable image inside an automatic maintenance window.
  rollback Restore RELEASE_RECORD from a previous deployment on that server.

release/rollback require W2W_RELEASE_APPROVED=1 after operator coordination.
DEPLOY_SERVER must be explicitly set to the SSH user@hostname (or user@IP).
DEPLOY_DIR must be the discovered absolute directory containing Compose and .env.
release also requires RELEASE_HEALTH_URL=https://<confirmed-domain>/health.
No SSH keys, host trust, bot services, proxy or Redis upgrades are managed here.
See docs/RELEASE.md before publishing or changing a server.
EOF
}

clean_revision() {
  cd "$repo_dir"
  [[ -z $(git status --porcelain=v1 --untracked-files=normal) ]] ||
    fail 'Commit/review the intended release changes first; the checkout must be clean.'
  revision=$(git rev-parse --verify 'HEAD^{commit}')
  [[ $revision =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a full Git commit SHA.'
  [[ $image_repository =~ ^[a-z0-9][a-z0-9./:_-]*$ ]] || fail 'Invalid image repository.'
  image="$image_repository:$revision"
  verification_file=$(git rev-parse --git-path w2w-release-verified)
}

verify() {
  clean_revision
  local expected_revision=$revision
  rm -f -- "$verification_file"
  (
    cd "$repo_dir/remix"
    npm ci --cache "${npm_config_cache:-${NPM_CONFIG_CACHE:-$HOME/.npm}}" --no-audit --no-fund --strict-ssl=true --engine-strict
    npm run typecheck
    npm run lint
    npm run build
    npm test
  )
  "${W2W_TEST_PYTHON:-python3}" -m unittest discover -s "$repo_dir/deploy/maintenance" -p 'test_*_unit.py'
  clean_revision
  [[ $revision == "$expected_revision" ]] || fail 'HEAD changed during validation.'
  printf '%s\n' "$revision" > "$verification_file"
  printf 'Verified commit: %s\n' "$revision"
}

require_verified() {
  clean_revision
  [[ -f $verification_file ]] && [[ $(cat "$verification_file") == "$revision" ]] ||
    fail 'Run verify/build successfully for this exact clean commit first.'
}

require_coordinated_release() {
  [[ ${W2W_RELEASE_APPROVED:-} == 1 ]] || fail 'Coordinate the server change, then set W2W_RELEASE_APPROVED=1.'
  [[ -n $deploy_target ]] || fail 'Set DEPLOY_SERVER to the SSH user@hostname before deploying.'
  [[ ${DEPLOY_DIR:-} == /* ]] || fail 'Set DEPLOY_DIR to the discovered absolute Compose directory.'
  [[ $deploy_target =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$ ]] || fail 'Invalid DEPLOY_SERVER; expected user@hostname or user@IP.'
}

run_remote() {
  local command='env W2W_RELEASE_APPROVED=1 bash -s --' argument quoted
  for argument in "$@"; do
    printf -v quoted '%q' "$argument"
    command+=" $quoted"
  done
  # Keep existing authentication and host-key verification intact.
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$deploy_target" "$command" < "$repo_dir/remix/update.sh"
}

run_bundle_remote() (
  # Build/publish have already finished. These are public source files, never .env
  # or credentials. A unique, bounded bundle cannot overwrite the server checkout.
  local transfer_dir metadata_file bundle_file bootstrap_file command result
  transfer_dir=$(mktemp -d)
  trap 'rm -rf -- "$transfer_dir"' EXIT
  metadata_file="$transfer_dir/metadata.json"
  bundle_file="$transfer_dir/release.tar"
  bootstrap_file="$transfer_dir/bootstrap.py"
  python3 "$repo_dir/deploy/maintenance/package.py" --revision "$revision" --output "$bundle_file" > "$metadata_file"
  python3 - "$repo_dir" "$revision" "$bootstrap_file" <<'PY'
from pathlib import Path
import subprocess
import sys

repo, revision, output = sys.argv[1:]
name = "deploy/maintenance/bootstrap.py"
entry = subprocess.check_output(["git", "-C", repo, "ls-tree", "-z", revision, "--", name]).split(b"\0")
if len(entry) != 2 or entry[1] != b"":
    raise SystemExit("Missing receiver source")
header, path = entry[0].split(b"\t", 1)
mode, kind, oid = header.split()
if path.decode() != name or kind != b"blob" or mode not in (b"100644", b"100755"):
    raise SystemExit("Receiver source must be a regular Git blob")
body = subprocess.check_output(["git", "-C", repo, "cat-file", "blob", oid.decode()])
if len(body) > 524288:
    raise SystemExit("Receiver source exceeds size limit")
with Path(output).open("xb") as stream:
    stream.write(body)
PY
  command=$(python3 - "$metadata_file" "$bootstrap_file" "$DEPLOY_DIR" "$RELEASE_HEALTH_URL" "$RELEASE_IMAGE" "$revision" <<'PY'
import json
from pathlib import Path
import re
import shlex
import sys
from urllib.parse import urlsplit

metadata_path, bootstrap_path, compose_dir, health_url, image, revision = sys.argv[1:]
url = urlsplit(health_url)
if not (url.scheme == "https" and url.hostname and re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", url.hostname)
        and url.port in (None, 443) and not url.username and not url.password
        and url.path == "/health" and not url.query and not url.fragment):
    raise SystemExit("RELEASE_HEALTH_URL must be the confirmed https://DNS-host/health URL")
metadata = json.loads(Path(metadata_path).read_text())
if metadata["revision"] != revision:
    raise SystemExit("Bundle revision mismatch")
command = ["env", "W2W_RELEASE_APPROVED=1", "PYTHONDONTWRITEBYTECODE=1", "python3", "-c", Path(bootstrap_path).read_text(),
           "--compose-dir", compose_dir, "--host", url.hostname, "--image", image, "--revision", revision,
           "--archive-sha256", metadata["archive_sha256"], "--manifest-sha256", metadata["manifest_sha256"]]
print(shlex.join(command))
PY
  )
  result=0
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$deploy_target" "$command" < "$bundle_file" || result=$?
  if (( result == 255 )); then
    printf '%s\n' 'SSH transport ended without a confirmed result. Inspect the server transaction before any retry; this command will not resend the release.' >&2
  elif (( result != 0 )); then
    printf '%s\n' 'Release did not complete successfully. Review the server result: recovery may have restored the prior version or retained maintenance.' >&2
  fi
  return "$result"
)

case "$action" in
  help|-h|--help) usage ;;
  verify) verify ;;
  build)
    verify
    build_options=(--platform linux/amd64 --load --build-arg "APP_REVISION=$revision"
      --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY)
    if [[ -n ${NODE_EXTRA_CA_CERTS:-} && -f $NODE_EXTRA_CA_CERTS ]]; then
      build_options+=(--secret "id=proxy_ca,src=$NODE_EXTRA_CA_CERTS")
    fi
    docker buildx build "${build_options[@]}" -f "$repo_dir/remix/dockerfile" -t "$image" "$repo_dir/remix"
    printf 'Built local image: %s\n' "$image"
    ;;
  publish)
    require_verified
    [[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$revision" ]] ||
      fail 'The local image revision does not match the verified commit.'
    docker push "$image"
    printf 'Published digest(s); use the matching repository@sha256 reference for release:\n'
    docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image"
    ;;
  release)
    require_coordinated_release
    require_verified
    [[ ${RELEASE_IMAGE:-} =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]] || fail 'RELEASE_IMAGE must be an immutable registry digest.'
    [[ ${RELEASE_HEALTH_URL:-} == https://* ]] || fail 'Set the confirmed HTTPS RELEASE_HEALTH_URL.'
    run_bundle_remote
    ;;
  rollback)
    require_coordinated_release
    [[ ${RELEASE_RECORD:-} == /* ]] || fail 'Set RELEASE_RECORD to the exact record directory printed by release.'
    run_remote rollback "$DEPLOY_DIR" "$RELEASE_RECORD"
    printf 'Rollback completed locally on the server. Verify public HTTPS and normal user flow before closing the incident.\n'
    ;;
  *) usage >&2; exit 2 ;;
esac
