# Maintenance page and automatic release windows

This host-local tool serves `index.html` from the existing nginx proxy while the
application is stopped or removed. `deploy-auto.sh release` and the main Actions
deployment automatically manage a maintenance window. Building and publishing
leave the site available. Merely opening the HTML or adding these files never
switches a running site into maintenance.

The supported installation is the reviewed nginx-proxy image
`jwilder/nginx-proxy@sha256:dd563441c6037b0faaede052359731eef319d2eb465d11e089dc4a4c4d499c04`,
with `TRUST_DOWNSTREAM_PROXY=false`, one Docker network, normal HTTPS redirects,
and the existing `certs`, `vhost` and `html` bind directories beside Compose.
Custom virtual paths, root location overrides, certificate selection, or another
container advertising this host stop the operation for separate review.

The standalone `maintenance.py` tool only queries non-secret routing metadata; it never reads `.env`, TLS
private keys, Redis data, or deployment credentials. It never pulls/builds an
image, recreates the proxy, changes trusted proxy addresses, or replaces the app,
Redis or ACME containers. The automatic coordinator additionally runs the
existing app updater, which reads protected runtime configuration and changes
only the persisted app image selection; it never logs configuration values.
Run manual maintenance commands on the confirmed server through the established
strict SSH connection to its **DNS hostname**. These commands do not establish
SSH trust or copy files to the server.

## Inspect, enable, restore

First put the reviewed `deploy/maintenance/` files together on the confirmed
server. Use the real absolute Compose directory and the intended DNS hostname.
Inspect is read-only and creates neither a container nor a state directory:

```sh
python3 deploy/maintenance/maintenance.py inspect \
  --compose-dir /home/zheyuan_wei2003/CSCC09-24F-Project/remix \
  --host w2w.space
```

The tool explicitly selects the host's local `/var/run/docker.sock`, ignoring
inherited Docker endpoint/context/TLS selectors. It retains `DOCKER_CONFIG`,
registry credentials and configured client proxy settings. It does not log in,
download images or select a remote Docker daemon.

After coordinating the maintenance window, enable explicitly:

```sh
python3 deploy/maintenance/maintenance.py enable \
  --compose-dir /home/zheyuan_wei2003/CSCC09-24F-Project/remix \
  --host w2w.space
```

Enable installs a dedicated, previously absent root-location hook and a copy of
the public HTML. It starts one separately labelled maintenance anchor, using the
same already-local immutable proxy image as a standalone nginx process. The
anchor has no Docker socket, secrets, certificates, published host ports or
application mounts. It runs as UID 101 with a read-only filesystem, dropped
capabilities, no new privileges, a small temporary filesystem and two read-only
mounts for its own public page/configuration. Its `VIRTUAL_HOST` and
`LETSENCRYPT_HOST` preserve the normal generated TLS/ACME vhost when the app is
gone. nginx-proxy serves the static 503 document directly; it does not balance
normal application requests into the anchor while maintenance is enabled.

Maintenance requests, including `/health`, receive **503**, `Retry-After: 120`
and `Cache-Control: no-store`. The original browser URL remains unchanged. HEAD
has the same status and headers without a body; mutating requests and WebSocket
handshakes cannot reach the app through the maintenance root location. The
normal HTTP-to-HTTPS redirect and HTTP ACME challenge location remain in place.
The static error location explicitly retains HSTS because adding location-level
headers otherwise stops nginx's parent `add_header` inheritance. CSP allows the
self-contained inline styles and data images/fonts and prohibits scripts.

Restore only after the actual app's internal `/health` is healthy at the reviewed
full commit. Supply that commit explicitly:

```sh
python3 deploy/maintenance/maintenance.py disable \
  --compose-dir /home/zheyuan_wei2003/CSCC09-24F-Project/remix \
  --host w2w.space \
  --expected-commit THE_REVIEWED_FULL_40_CHARACTER_COMMIT
```

Disable refuses to expose an unhealthy app or a different commit. It removes
only the unchanged owned hook and the recorded exact anchor, lets docker-gen
regenerate with a one-shot invocation of its exact reviewed template, runs
`nginx -t`, reloads, and verifies public HTTPS `/health` against
that commit. If restoration fails, it reinstates the maintenance hook/anchor and
checks the 503 page, then returns failure. It removes the unchanged public asset
only after normal health verifies. Small non-secret recovery records remain;
the next enable archives a completed record. Altered files or replacement
containers require inspection and are never blindly deleted.

## Release coordination and failures

`deploy-auto.sh release` sends the tested source from the exact verified commit
to a new private server staging directory. `auto_release.py` holds one shared
lock for the complete window and gives the updater a verified inherited lock
descriptor. It records operation ownership before enabling maintenance and uses
only its own updater result and rollback record. An existing manual window or
unfinished foreign operation is refused, without removing its hook or anchor.

The sequence is: verify the current installation, enable and confirm the 503
page, run the fresh Redis backup/restore rehearsal and image update, verify
internal health and persisted image, restore routing, and confirm public HTTPS
health/version. A failed target is rolled back to the actual prior runtime;
the window closes only after that prior version is healthy publicly. Failed
recovery keeps maintenance enabled and exits unsuccessfully. Application
rollback does not restore old Redis data. See [release instructions](../../docs/RELEASE.md)
for transfer validation, unknown transport outcomes and interrupted transactions.

The following manual sequence remains available for a separately coordinated
window. Do not run automatic release inside a manually enabled window:

1. Validate/build/test/publish the intended exact commit through the existing
   release procedure. Retain its immutable image digest and previous image.
2. Enable maintenance and confirm the 503 page through HTTPS.
3. On the confirmed host, run the **reviewed `remix/update.sh` from that exact
   tested commit** with `W2W_RELEASE_APPROVED=1`, action `release`, the confirmed
   Compose directory, immutable image digest and full commit as its arguments.
   Do not use a stale server checkout's script. It retains the existing fresh
   Redis snapshot, isolated restore rehearsal, default-image persistence,
   internal exact-version verification and app-only rollback. The maintenance
   tool releases the normal release lock after each command; it does not wrap
   or silently authorize that application operation.
4. Once internal health verifies, disable maintenance with `--expected-commit`
   set to that same commit, then verify public health, key user flows and UI.
5. If the application release fails, inspect its new record and actual runtime.
   If needed, use the existing reviewed `update.sh rollback` operation with its
   exact record. Disable maintenance only when the recovered app is healthy,
   using the recovered commit. Never restore an old Redis snapshot as part of
   an application rollback.

The tool shares the local release lock to avoid an overlapping server mutation.
It records `preparing`, `enabling`, `enabled`, `disabling` and recovery outcomes
under `.w2w-maintenance-<installation-key>/state.json`. File writes are atomic;
container lifecycle and proxy reload are separate operations. An interrupted
process or host outage needs inspection of that record, hook, anchor and actual
app health before another change. A failed enable restores normal routing only
when the original app is healthy; otherwise it retains the maintenance artifacts
and reports failure. Recovery failure is always an error, never a successful
mode switch. Do not delete hooks or stop the anchor to make a health check green.

An explicit one-shot render is necessary: removing an anchor that has already
stopped does not produce a watched network event. Waiting for an unrelated
container event can otherwise leave a stale include pointing at a removed hook.
The render uses the same proxy/template and existing Docker filter environment,
with the same resolver calculation as its entrypoint; it does not restart the
proxy or change its address or forwarding policy.

Direct access to any separately published application port is outside the
nginx virtual host; maintenance does not change host firewall or port mappings.
The maintenance document cannot prevent clients with existing P2P connections
from continuing transfers already established between them.

## Local verification

The deterministic controller/transport unit tests are also part of
`deploy-auto.sh verify` and require no Docker or production access:

```sh
python3 -m unittest discover -s deploy/maintenance -p 'test_*_unit.py'
```

The automatic-release rehearsal uses real disposable Docker/Compose services,
TLS with a local CA, a private loopback registry and synthetic Redis data. Run
it separately with an evidence directory; it never targets production:

```sh
python3 deploy/maintenance/test_auto_release.py \
  --evidence-dir /workspace/w2w-auto-maintenance-rehearsal
```

```sh
python3 deploy/maintenance/test_maintenance.py \
  --evidence-dir /workspace/w2w-maintenance-test
```

`test_maintenance.py` uses an isolated, uniquely labelled Docker network, the
same pinned proxy image and a disposable app fixture. It binds only loopback
ports and verifies TLS with a generated test CA, including matching hostname.
`--probe-address` is restricted to loopback for this test transport; production
probes use the DNS hostname and standard TLS verification. No TLS bypass is
provided. The test exercises app removal, ACME challenge bypass, response
semantics, refusal to unmask an unhealthy app, and failed restoration recovery.
It removes only its own test containers/network and temporary certificate key.

The HTML has also been checked over an HTTP preview in desktop and mobile
browser views. This environment blocked a `file://` opening under its browser
policy; local-file opening has not been verified here.
