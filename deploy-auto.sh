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
  release  Deploy RELEASE_IMAGE=repository@sha256:... to confirmed DEPLOY_DIR.
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
    run_remote release "$DEPLOY_DIR" "$RELEASE_IMAGE" "$revision"
    for attempt in {1..12}; do
      if curl --proto '=https' --fail --silent --show-error --max-time 10 "$RELEASE_HEALTH_URL" |
        node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{const j=JSON.parse(s);if(j.status!=="ok"||j.version!==process.argv[1])process.exit(1)}catch{process.exit(1)}})' "$revision"; then
        printf 'Release verified through HTTPS: %s\n' "$revision"
        exit 0
      fi
      sleep 2
    done
    fail 'External health/version verification failed. The local app passed; coordinate rollback using the printed release record.'
    ;;
  rollback)
    require_coordinated_release
    [[ ${RELEASE_RECORD:-} == /* ]] || fail 'Set RELEASE_RECORD to the exact record directory printed by release.'
    run_remote rollback "$DEPLOY_DIR" "$RELEASE_RECORD"
    printf 'Rollback completed locally on the server. Verify public HTTPS and normal user flow before closing the incident.\n'
    ;;
  *) usage >&2; exit 2 ;;
esac
