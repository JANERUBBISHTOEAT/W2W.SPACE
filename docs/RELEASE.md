# W2W release and rollback

The confirmed SSH target is `zheyuan_wei2003@34.130.69.135`. Coordinate each
server mutation with the task owner before executing a release or rollback.
The server Compose directory has been confirmed as
`/home/zheyuan_wei2003/CSCC09-24F-Project/remix`; scripts still require an explicit
`DEPLOY_DIR` so operators can check the selected installation. The public health
URL must be confirmed before release.
These scripts do not change SSH authentication, QQ-bot services, certificates,
the reverse proxy, Redis versions, or the production data schema.

## Compatibility and release boundary

- Use the pinned Node 24.22.1 runtime and committed npm lockfile. The image
  target is `linux/amd64`; confirm that matches the deployment host.
- The application image must carry `org.opencontainers.image.revision` and
  `APP_REVISION` equal to its full Git commit. `/health` must return HTTP 200 with
  `{"status":"ok","version":"<full commit>"}` only when Redis is available.
- Review the server's Compose configuration before rollout. The `remix` image
  must use `W2W_IMAGE`. Keep its existing Compose project identity, network,
  volume and proxy routing. Supply `SESSION_SECRET` securely, at least 32
  characters; keep its value out of commands, logs and images.
- `GOOGLE_CLIENT_ID` is optional for anonymous use. If OAuth is enabled, verify
  the production origin/client ID separately. Changing the session secret
  invalidates existing cookies; assess and communicate that before deployment.
- Use the existing Redis image and volume. Do not combine application deployment
  with Redis/proxy upgrades, volume replacement, data migration or image pruning.
- The normal release swaps only `remix`, so a brief application restart is
  expected. Proxy and Redis remain running. This is not a zero-downtime rollout.

## Read-only discovery and prerequisites

Before approving mutations, establish the real absolute Compose directory,
Compose project name, running app/Redis containers, image IDs/digests, host
architecture, available disk/memory, HTTPS hostname and current behavior.
If Compose was started with `-p` or extra override files, preserve those through
the existing project configuration/environment; stop if the scripts cannot
select exactly the existing services. Do not print full `docker inspect`,
`docker compose config`, `.env` or process environments: they can expose
credentials. Query only specific non-secret fields.

Use an authorized operator's existing SSH credentials on their trusted machine.
Do not copy private keys into the cloud or change SSH authentication as a
release workaround. Verify account isolation and protection of runtime files
with the server owner before deployment; retain host-specific security findings
in the private operational review. This application release does not change
users, groups, sudo policy or file permissions.

The deployment host needs Bash, Docker with Compose v2, Python 3, `flock` and
`sha256sum`. Local publishing needs Docker Buildx and existing registry access.
SSH uses existing credentials, batch mode and strict host-key checking; resolve
missing access/host trust instead of weakening checks. The scripts do not
provision a new server or synchronize its checkout. Put the reviewed Compose file
and secure runtime configuration in place before rollout. Preserve the previous
configuration separately if it changes.

## Prepare and publish the exact release

Finish and commit the reviewed code first. `verify` refuses tracked/untracked
changes, runs frozen installation, typecheck, lint, build and tests, and records
the validated commit in local Git metadata. `build` runs that validation and
builds/loads an image tagged by the full commit; it does not push or deploy.

```bash
./deploy-auto.sh build
```

Before publishing, run the built image against an isolated Redis instance and
exercise anonymous sessions, text create/save/read/share, file-token resolution,
deletion/undo and relevant authorization failures. Verify `/health` returns the
built revision. Separately test browser/WebRTC and OAuth if those are release
acceptance criteria. Record passed, failed and not-run checks; a build alone is
insufficient. After artifact validation and publication authorization:

```bash
./deploy-auto.sh publish
```

This publishes the commit tag and prints registry digest references. Select the
matching `zheyuanwei/w2w@sha256:...` reference for release. It does not deploy.
`W2W_IMAGE_REPOSITORY` can explicitly select another approved repository.
Existing proxy and CA trust are preserved during builds; TLS verification stays
enabled.

## Coordinated rollout

Export `DEPLOY_DIR` as the confirmed **absolute** Compose directory and
`RELEASE_HEALTH_URL` as the confirmed public HTTPS `/health` URL. Do not use
placeholder values for a real deployment. Export `RELEASE_IMAGE` as the published
digest reference, then run only after coordination:

```bash
W2W_RELEASE_APPROVED=1 ./deploy-auto.sh release
```

The script checks the clean, locally verified commit and streams the reviewed
`remix/update.sh` to the host. It does not alter the server checkout. The server
script verifies image selection/revision, records the previous app image ID and
available registry digests, and keeps a rollback tag. Release records default to
`$HOME/.local/state/w2w-releases` with restrictive permissions.
`W2W_RELEASE_STATE_DIR` can select another protected location when invoking
`update.sh` directly on the server.

Before replacing the app, it snapshots Redis to an RDB, records its checksum,
checks the format, and rehearses loading it with the **existing Redis image** in
a disposable container with networking disabled and a read-only backup mount.
The production volume is never mounted into that rehearsal. Redis authentication
must already be available securely to `redis-cli`; never put a password in
command arguments. Backup/restore failure stops the rollout. Ensure there is
enough disk/memory for the backup and temporary Redis before approving it.

The replacement uses `compose up -d --no-deps --pull never --no-build remix`.
The script verifies the running image ID and `/health` revision inside the new
container. Failed replacement/internal health triggers app-only rollback and a
failing exit status. The local wrapper then verifies public HTTPS health/version.
External verification failure is reported as a failed release; coordinate a
rollback using the printed record if the public route cannot be corrected within
the release window. Deployment is complete only after the public route, intended
version and bounded user-flow smoke test pass.

Keep the printed release record, published digest, previous image ID, validation
results and release time. No image or backup pruning occurs. Future Compose
operations must retain the selected `W2W_IMAGE` digest; the script records it in
`current-image` instead of rewriting `.env`.

## Application rollback

Export `RELEASE_RECORD` as the exact absolute record directory printed before
rollout, and retain the same confirmed `DEPLOY_DIR`. After coordinating rollback:

```bash
W2W_RELEASE_APPROVED=1 ./deploy-auto.sh rollback
```

Rollback selects the previous **image ID**, recreates only `remix`, and verifies
that exact image and app health. For a legacy image without a valid revision
label, it verifies the exact image ID and rendered homepage, explicitly
reporting that endpoint-based version verification is unavailable. Verify public
HTTPS and expected user behavior manually before closing rollback. Keep
Redis/proxy unchanged and preserve new user data; rollback never restores an
older database automatically.

## Backup recovery boundary

The record contains `redis.rdb`, its SHA-256 checksum, the original Redis image ID
and prior application references. Backups contain user data: protect/retain them
under the organization's backup policy. The isolated restore rehearsal verifies
loadability before rollout.

Production data restoration is a separate, coordinated recovery operation.
Retain the current volume and quiesce all writers; inspect actual Redis `dir`,
`dbfilename` and AOF settings without exposing credentials. Rehearse recovery with
the recorded Redis version and a separate volume. An RDB copy alone does not
replace enabled AOF safely. Do not delete/overwrite production volumes or AOF
files through this release script. Confirm the specific recovery plan, expected
data loss window and rollback volume before switching to recovered data.
