# W2W release and rollback

Set `DEPLOY_SERVER` explicitly to the SSH target, for example
`zheyuan_wei2003@w2w.space`. There is no built-in IP address. When the domain's
A record changes, SSH follows DNS; keep that record pointed at the real origin
server rather than an HTTP-only proxy. Coordinate manual server mutations with
the task owner; the configured Actions workflow authorizes releases on `main`.
The server Compose directory has been confirmed as
`/home/zheyuan_wei2003/CSCC09-24F-Project/remix`; scripts still require an explicit
`DEPLOY_DIR` so operators can check the selected installation. The public health
URL must be confirmed before release.
These scripts do not change SSH authentication, QQ-bot services, certificates,
the reverse proxy, Redis versions, or the production data schema.

## GitHub Actions automation

`.github/workflows/deploy.yml` runs on pushes to `main`, or through **Actions →
Deploy W2W → Run workflow** with `main` selected. It validates the exact commit,
builds an image, checks it with disposable Redis, publishes its commit tag, and
deploys the resulting immutable digest with the existing backup/rollback and
internal/public health checks. Only one production run proceeds at a time; an
active release is not cancelled by a new push. Merging into `main` therefore
authorizes an automatic production release.
Pull requests targeting `main` run the application validation and shell syntax
checks without deployment credentials; they never publish or change the server.

Configure these repository **Actions variables** under **Settings → Secrets and
variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `DEPLOY_SERVER` | SSH target, e.g. `zheyuan_wei2003@w2w.space` |
| `DEPLOY_DIR` | `/home/zheyuan_wei2003/CSCC09-24F-Project/remix` after confirming the installation |
| `RELEASE_HEALTH_URL` | `https://w2w.space/health` after confirming public routing |
| `DEPLOY_KNOWN_HOSTS` | Trusted OpenSSH `known_hosts` line(s) matching the hostname in `DEPLOY_SERVER` |
| `W2W_IMAGE_REPOSITORY` | Optional; defaults to `zheyuanwei/w2w` |

Configure these repository **Actions secrets**:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | Private deployment key already authorized for the server account; unencrypted for noninteractive CI |
| `DOCKERHUB_USERNAME` | Docker Hub account with push access to the image repository |
| `DOCKERHUB_TOKEN` | Docker Hub access token with the required push access |

Verify the SSH host fingerprint through an existing trusted connection or the
server console before saving `DEPLOY_KNOWN_HOSTS`; an unverified `ssh-keyscan`
result alone does not establish trust. Store the private deployment key only in
Secrets, never in a variable, source file or log. CI fails before building when
required configuration or SSH access is missing. A DNS/IP change on the same
host normally keeps the same host key; a replacement host requires independently
verifying its new key and updating the pinned record.

The server still needs the reviewed Compose file and runtime `.env` in place;
the workflow deploys the application image and does not synchronize those files.
For manual commands, export the same `DEPLOY_SERVER`, `DEPLOY_DIR` and
`RELEASE_HEALTH_URL` values in your shell. Local validation/build/publish do not
require `DEPLOY_SERVER`.

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
- The default `.env` in that Compose directory must be a protected, writable
  regular file, without symbolic/hard links or group/other write permission.
  Keep one simple unquoted `W2W_IMAGE` assignment (or omit it so release can add
  it). Other values may use single-line dotenv quoting; multiline values and
  alternate `COMPOSE_FILE`, `COMPOSE_ENV_FILES` or `COMPOSE_DISABLE_ENV_FILE`
  assignments in the shell or `.env` are unsupported and stop before rollout.
- Configure `TRUSTED_PROXY_CIDRS` with the verified immediate nginx proxy IPs
  or CIDRs. The application defaults to trusting no forwarding headers; aliases,
  wildcards and all-address ranges are rejected. Verify nginx overwrites
  `X-Forwarded-Proto` and `X-Forwarded-Host`. Recheck this configuration if proxy
  addresses change. Do not use a broad private range as a convenience exception.
- React Router 7 preserves sharing URLs, resource JSON APIs and Redis records.
  Same-secret signed cookies remain compatible. Its browser data protocol has
  changed: existing Remix 2 tabs must reload once after rollout. Do not keep old
  and new application instances serving incompatible browser data protocols
  interchangeably. No Redis schema migration is needed.
- `GOOGLE_CLIENT_ID` is optional for anonymous use. If OAuth is enabled, verify
  the production origin/client ID separately. Changing the session secret
  invalidates existing cookies; assess and communicate that before deployment.
- Use the existing Redis image and volume. Do not combine application deployment
  with Redis/proxy upgrades, volume replacement, data migration or image pruning.
- The normal release swaps only `remix`, so a brief application restart is
  expected. Proxy and Redis remain running. This is not a zero-downtime rollout.

An optional independent [maintenance page](../deploy/maintenance/README.md) is
available for separately coordinated windows. It is not enabled by Actions or
the normal release command. Maintenance deliberately returns HTTP 503, including
on `/health`; follow its explicit enable, internal release and verified restore
sequence instead of bypassing the existing public health check.

## Read-only discovery and prerequisites

Before approving mutations, establish the real absolute Compose directory,
Compose project name, running app/Redis containers, image IDs/digests, host
architecture, available disk/memory, HTTPS hostname and current behavior.
Preserve the existing project identity and automatically loaded Compose override
file. The release script edits only the fixed default `.env`; installations
requiring alternate Compose/environment-file selectors need a separately reviewed
workflow. Stop if the scripts cannot select exactly the existing services.
Do not print full `docker inspect`,
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

After backup verification, the script atomically updates only `W2W_IMAGE` in the
default `.env`, preserving its other bytes, line endings, owner, group, mode and
extended attributes. A temporary file in the same directory is flushed and
renamed over `.env`; no full environment backup is retained in release records
or printed. The script checks Compose with `W2W_IMAGE` unset and allows only the
`remix.image` field to change; proxy, trust, Redis and other settings must match.

The replacement uses `compose up -d --no-deps --pull never --no-build remix`
without a shell image override. The script verifies the running image ID,
`/health` revision and the default image selection. Failed persistence,
replacement or internal health triggers app-only rollback and a failing exit
status. Recovery uses the actual pre-release container image, even if the old
default `.env` selected a different stale image. If persistence or Docker is also
unavailable during rollback, the script reports incomplete recovery and retains
the record; it does not claim success. The local wrapper then verifies public HTTPS health/version.
External verification failure is reported as a failed release; coordinate a
rollback using the printed record if the public route cannot be corrected within
the release window. Deployment is complete only after the public route, intended
version and bounded user-flow smoke test pass.

Keep the printed release record, published digest, previous image ID, validation
results and release time. No image or backup pruning occurs. After a successful
release, ordinary Compose configuration/recreation selects the verified digest
from `.env`; `current-image` records the same reference. An explicit
`W2W_IMAGE=... docker compose ...` remains available for a separately coordinated
override and does not alter the persisted default.

The record's `status` distinguishes pending release/rollback from verified
completion. Updating a file and replacing a container cannot be one atomic
operation: a killed process or host outage can interrupt between them. Before
recovery, inspect that record, the actual running image and the default Compose
image with the shell override unset; do not infer success from a pending record.
Use the coordinated rollback below to restore the recorded previous runtime and
its persisted default, then verify public health.

## Application rollback

Export `RELEASE_RECORD` as the exact absolute record directory printed before
rollout, and retain the same confirmed `DEPLOY_DIR`. After coordinating rollback:

```bash
W2W_RELEASE_APPROVED=1 ./deploy-auto.sh rollback
```

Rollback persists the previous runtime's immutable registry reference when it
still resolves to the recorded **image ID**, or uses that local image ID as the
fallback (also supporting older release records). It recreates only `remix` and
verifies that exact image, app health and the default Compose selection without
a shell override. For a legacy image without a valid revision
label, it verifies the exact image ID and rendered homepage, explicitly
reporting that endpoint-based version verification is unavailable. Verify public
HTTPS and expected user behavior manually before closing rollback. Keep
Redis/proxy unchanged and preserve new user data; rollback never restores an
older database automatically.

If an explicit rollback fails after it starts changing the app/default image,
the script attempts to restore the actual pre-rollback image and its default.
It still exits unsuccessfully and records `rollback-failed-restored` only when
that recovery verifies. If recovery also fails, retain the record and inspect
both selections before another coordinated operation.

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
