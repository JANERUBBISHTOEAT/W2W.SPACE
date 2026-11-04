# Runtime, dependency migration and verification

This report covers the maintained application in `remix/` and its committed
lockfile. The unused historical `POC/` package has been removed with the owner's
authorization, leaving one maintained application package to audit.
Deployment and rollback procedures are in [RELEASE.md](RELEASE.md).

## November 4, 2026 security review

This follow-up starts from remote `main` at `b4f1429`, rather than the older
`work` checkout or an uncommitted patch in another workspace. The starting
lockfile already contains `path-to-regexp` 0.1.13, the patched version for
[GHSA-37ch-88jc-xwx2](https://github.com/advisories/GHSA-37ch-88jc-xwx2).
Version 0.1.12 is still affected and must not replace it.

A fresh npm audit found seven moderate package/meta-vulnerability entries, all
from [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
minimatch `>=7 <11.0.1`. Production-only audit already had zero entries.
The affected copies were minimatch 9.0.9 under `@react-router/fs-routes`
and 10.2.6 under `@typescript-eslint/typescript-estree`.

The fix removes `@react-router/fs-routes` and declares the same 16 routes with
the framework's `route`/`index` helpers. Before/after `react-router routes --json`
outputs are byte-identical, including IDs, files, paths, ordering and hierarchy.
This avoids forcing minimatch 11 into a consumer that calls `makeRe()`, an API
removed in [minimatch 11](https://github.com/isaacs/minimatch/blob/v11.0.1/changelog.md).
New route modules must now be registered in `app/routes.ts`.

A scoped override upgrades only typescript-estree's minimatch to 11.0.1.
That consumer uses the retained `minimatch(filePath, pattern, { dot: true })`
interface. Real parser/project-service regression tests verify matching,
nonmatching and hidden-file default-project behavior, including type information.
The unrelated minimatch 3.1.5 consumers remain unchanged; this advisory does not
include that version.

Code review also reproduced a sharing defect: when a visitor received a file
and then logged in, `mergeFiles` allocated a recipient-specific token instead of
retaining the sender's shared token. Deleting the sender's history could then
invalidate the original link even while the recipient retained the file.
Login migration now moves existing server-owned records with their token and
metadata, preserving the duplicate check. An isolated Redis regression failed
before the fix and passes afterward; it also checks final-recipient deletion
and account-file deduplication.

Current checks run on Node 24.22.1 / npm 11.19.1:

| Check | November 4 result |
| --- | --- |
| Frozen `npm ci --engine-strict` using the updated lockfile | Passed |
| Full and production-only `npm audit --json` | Both zero known advisories |
| Route manifest comparison | All 16 routes byte-identical |
| Type generation and TypeScript | Passed |
| ESLint with `--max-warnings=0` | Passed |
| Production build | Passed; upstream future-flag and chunk-splitting notices remain |
| Complete regression suite | 30 tests passed, zero failures/skips/cancellations |
| Browser comparison against `b4f1429` | 44 screenshots / 22 pairs; 20 pairs pixel-identical, two differ only in the Monaco scrollbar; 28 interactions passed, zero page errors |
| Client build artifact comparison | All 57 files byte-identical |
| Docker image build and runtime | Passed against code commit `51d88a5`: eight check groups, correct image/revision, UID 1000 and built-in HEALTHCHECK healthy |
| Real browser file selection, local seeding and same-context download | Passed: 64 KiB file, real magnet/token, saved metadata/notes and byte-identical download |
| Cross-browser P2P | Attempted with default public trackers and separate local WS signaling; neither completed, zero received bytes |
| Real Google OAuth and production deployment | Not run in this follow-up |

Browser checks used Chromium 154.0.8037.57 with identical fixed Redis fixtures,
signed test sessions, locale/timezone and 1440x900 / 390x900 viewports. Both
versions ran production builds against separate disposable Redis instances.
The 11 checkpoints at each width cover dashboard, new-item menu, file details,
favorite state, file editing, saved notes, empty file, Monaco editor, saved text
with its real success notification, token reception and deletion confirmation.
Interactions verify persisted favorites/notes/title, exact clipboard values,
token reception and deletion cancellation. Screenshots used no masks or custom
CSS; animations and the input caret were disabled for capture.

All 11 narrow-viewport pairs are pixel-identical. The two desktop differences
are each 815 pixels (0.063%) within the rightmost Monaco scrollbar strip,
bounding box `[1426, 73, 1440, 862]`; image inspection confirms a scrollbar fade
color difference without content, layout or success-notification changes.
Existing narrow-screen horizontal overflow remains unchanged; full-page
screenshots therefore extend past the 390px viewport. The external visitor-count
service returned 403 for both versions, so its working appearance is not covered. No unexpected UI
change was found in the observed states; this does not verify real Google login.

The code changes were saved in local commit
`51d88a586e7296f5c5ab7fc02497e60eeee0b8c7`. Its tree was independently compared
with the previously tested patch applied to `b4f14293`; the trees match exactly.
The image `w2w-review:51d88a5` has ID
`sha256:616af87850b919c681cfcf0d457eaa442a4c223cd45e67ec464e7db93efa9727`.
Its image label, running container image and `/health` all match that full code
commit. Isolated Docker tests verify text/file HTTP sharing, ownership, deletion,
undo and final-recipient lifecycle. Vite, ESLint and `@react-router/dev` are
absent from the runtime, with no application `.env`, key or build-CA files.
TypeScript 5.9.3 remains as React Router's optional production peer. All test
containers and their separate network were removed; no production data was used.

Additional real-browser testing selected a 65,536-byte fixture through the file
chooser, seeded it in WebTorrent, saved its real magnet/token and notes, then
downloaded it through the application in the same browser context. Input and
download SHA-256 both equal
`f5dc4b6326a1c2f2cfc6dab83e723d71459586acfcefd250e118e866cbe8de22`.
This application shares client-side file bytes; that check does not establish a
server-side byte upload or a cross-peer transfer.

Two independent Chromium processes were also tested as sender and receiver.
The default public-tracker attempt did not complete within 45 seconds. Chromium
reported proxy-CA trust errors; a normal CA import into an isolated task profile
reached the native file picker, which the available headless tools could not
control. TLS verification and the global trust store were left unchanged.
In a separately labeled local-WS diagnostic, real offer/answer signaling worked,
but neither browser emitted a non-null ICE candidate; the receiver remained at
zero peers and zero bytes for 45 seconds. No ICE configuration, network policy or
payload was changed to force a pass. These observations do not verify public P2P
or establish that UDP is the sole cause. The active default-tracker trial also
recorded two `signal is aborted without reason` page errors; the earlier zero
page-error result applies specifically to the screenshot regression suite.

Historical GitHub security-notification emails were checked against the current
lockfile. They are not a live alert inventory. The repository's security page
returned HTTP 404 in this environment, and the previously denied Dependabot API
was not retried or bypassed. The zero counts above describe npm's current audit
results; they do not establish that GitHub's live alert list is empty. No changes
were pushed, merged or deployed.

## Versions and migration boundary

| Component | Selected version | Compatibility decision |
| --- | --- | --- |
| Node / npm | 24.22.1 / 11.19.1 | Pin `.node-version`, package engines (`>=24.22.1 <25`), package manager and Docker runtime. Node 20 is end of life; Node 24 is supported through April 30, 2028. |
| React Router framework | 7.18.4 | Replace Remix 2 and React Router 6, including the development/runtime packages. This is an intentional framework-major migration to upstream security fixes. |
| React / TypeScript / Vite | 18.3.1 / 5.9.3 / 6.4.5 | All satisfy the selected framework's published peer ranges. React 19 and Vite 8 are not prerequisites for these fixes. |
| WebTorrent / IP dependency | 2.8.5 / `@webpod/ip` 0.6.1 | Keep the browser torrent API; replace the tracker's vulnerable `ip` dependency through a scoped npm alias. |
| ESLint | 9.39.5 | Development-only deprecation exception: selected React/import/hooks plugins do not support ESLint 10. This is a support-lifecycle limitation, not a remaining known audit advisory. |

The framework migration updates shared API imports, Vite integration, file-route
configuration, type generation and server commands. React Router 7 uses its
current Single Fetch protocol; the old Remix `_data` requests and
`v3_singleFetch: false` assertion must not be carried forward. Existing tar,
DOMPurify and esbuild overrides retain patched versions where applicable. The
old React Router 6 overrides have been removed.

Application fixes from the earlier review remain part of this change: Google
credentials are verified server-side with `google-auth-library` instead of
merely decoded; production requires a configured session secret of at least 32
characters; session, ownership and login-origin checks protect relevant
mutations; file-token resolution and shared-record lifecycle defects are fixed.
Their behavior, legacy signed sessions and existing Redis records require
regression verification against the migrated framework. No Redis schema
migration is intended.

## Vulnerability priority and elimination evidence

Audit snapshots for this change progressed from **49 total vulnerable package
entries** (including two critical), to **19 total / 12 production** after the
initial compatible refresh, to **zero in both scopes** after the framework and
IP-library changes. These are npm's package/meta-vulnerability counts, not
counts of distinct exploitable application defects.

The remaining 19 entries were addressed through their dependency roots:

| Intermediate entries | Root cause and final correction |
| --- | --- |
| `@remix-run/{dev,express,node,react,serve,server-runtime}`; `react-router`, `react-router-dom`, `turbo-stream` (9 entries) | Remix 2 retained React Router 6 and standalone turbo-stream 2.4.1. Replace the framework with matched `react-router` and `@react-router/*` 7.18.4 packages. The six old Remix packages, `react-router-dom` and standalone `turbo-stream` are absent from the final lockfile. |
| `@vanilla-extract/integration`, `vite-node`, `vite`; `remark-mdx-frontmatter`, `estree-util-value-to-estree`, `toml` (6 entries) | Obsolete Remix development chains retained Vite 5 and vulnerable frontmatter/TOML helpers. Removing Remix's development package removes those roots. The final graph uses Vite 6.4.5 and vite-node 3.2.4; the old vanilla-extract/frontmatter/TOML packages are absent. |
| `webtorrent`, `torrent-discovery`, `bittorrent-tracker`, `ip` (4 entries) | The upstream tracker still requests vulnerable `ip` 2.0.1. Its scoped override resolves `ip` to `npm:@webpod/ip@0.6.1`, replacing the implementation with a maintained compatible library. The original vulnerable package is absent; the torrent packages remain. |

Framework fixes are upstream changes, not advisory suppression:

- [GHSA-rxv8-25v2-qmq8](https://github.com/advisories/GHSA-rxv8-25v2-qmq8): React Router 7.14.0 removed recursion from its **vendored turbo-stream v2 fork**. Version 7.18.4 includes that correction. It does not depend on forcing standalone turbo-stream 3 into Remix 2, nor on keeping Single Fetch disabled.
- [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6): React Router 7.18.0 consolidated URL normalization and mixed-slash handling; 7.18.4 includes that fix and later navigation validation improvements.
- [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg): React Router 7.18.0 changed framework hydration-error serialization and removed the vulnerable custom Data Mode deserialization behavior. Version 7.18.4 includes the fixes.

See the [versioned upstream changelog](https://github.com/remix-run/react-router/blob/react-router%407.18.4/packages/react-router/CHANGELOG.md)
and [Remix-to-React-Router migration guide](https://github.com/remix-run/react-router/blob/react-router%407.18.4/docs/upgrading/remix.md).

## IP replacement review

The [replacement's upstream documentation](https://github.com/webpod/ip)
explicitly describes compatibility with `ip` 2.0.1 and corrections for
[GHSA-2p57-rm9w-gvfp / CVE-2024-29415](https://github.com/advisories/GHSA-2p57-rm9w-gvfp)
and CVE-2023-42282. The reviewed 0.6.1 registry artifact's SHA512 matches its
published `dist.integrity`; the lockfile retains that integrity. It is
MIT-licensed, has no package dependencies, and supplies ESM/CJS implementations.
This uses the published package, not a locally vendored copy or a renamed
unmodified vulnerable package.

`tests/ip-compatibility.test.mjs` resolves the IP library **from the tracker's
own module location**. Three passing tests cover replacement identity, ESM/CJS
IPv4/IPv6 Buffer and numeric conversions, the CVE's ambiguous/private address
forms, and the real tracker UDP parser. The tracker server is imported without
constructing or listening on a server; no public tracker is contacted.
Noncanonical forms may now throw rather than be accepted, an intentional
validation change. `isPublic` remains a private-range classifier, not a
complete outbound-network authorization policy; this application does not use
it as such.

## Verification status for the final graph

| Check | Result |
| --- | --- |
| Frozen `npm ci` with engine enforcement and explicit cache | Passed on Node 24.22.1 / npm 11.19.1 |
| Full `npm audit --json` | Passed: zero known advisories in all severity categories |
| Production `npm audit --omit=dev --json` | Passed: zero known advisories in all severity categories |
| Targeted IP replacement tests | Passed: 3 tests, zero failures/skips, on Node 24.22.1 |
| Final type generation, TypeScript and lint | Passed; lint enforces zero warnings |
| Production build | Passed; chunk-splitting notices remain as described below |
| Complete application regression suite | Passed: 24 tests, including the 3 IP tests and file metadata/deduplication regressions; zero failures, skips or cancellations |
| Browser validation | Passed: 9 UI-restoration checkpoints, zero page errors; exact clipboard values, denied/unavailable clipboard handling, notes save and byte-exact same-context file download |
| Historical UI comparison | 14 of 15 screenshots pixel-identical to `8b2e1ba` across 1440px, 768px and 390px; one text-editor screenshot differs only in a 34×12px scrollbar color region |
| React Router 7 Docker build and runtime smoke | Passed for earlier commit `0e95c2c973fc64296f0248184f895de7d50e608c`: health reports that full SHA; UID 1000; no `.env` or Vite in the runtime image; text and file HTTP smoke flows pass. This image does not include the subsequent UI restoration; rebuild and smoke-test the intended release commit before deployment. |
| Reusable Node 24.22.1 installer replay | Passed, including the production build |
| Full cross-browser P2P transfer | Not verified: the transfer attempt did not complete under managed browser UDP restrictions |
| Real Google OAuth login | Not run; credential validation regressions do not replace a real login |
| Production deployment and deployed-version health check | Not run |

These checks were run against the migrated dependency graph and local release
candidate. They do not establish live deployment health or verify the explicitly
uncompleted P2P and real OAuth workflows. The build reports that shared server
utilities have both static and dynamic imports, so those dynamic imports cannot
move the modules into separate chunks. These are bundling notices; the build
and functional checks completed successfully, without suppressing them.

Audit results describe known advisories at the time of the query; they are not
a guarantee of freedom from unknown defects. Re-run both audit scopes and the
functional checks when the lockfile, framework behavior or release image changes.

The UI restoration uses the pre-upgrade Git baseline `8b2e1ba`: file-link Copy
returns to the input row, the favorite star returns inside the heading, and the
added detail-page Copy token and Receive file controls are removed. New cards
retain their original appearance with keyboard access. Baseline narrow-screen
overflow is unchanged. The visual comparison used historical source, not the
user's supplied screenshots. Existing ownership checks and secure clipboard
behavior remain in place.

The browser regression also exposed a pre-existing duplicate-detection defect:
opening or favoriting a populated file could match an unrelated empty draft.
Metadata-only updates now stay on the requested record; identity changes compare
the complete candidate and retain omitted notes. Regression tests cover this and
the intended duplicate-save behavior. The successful same-context download checks
the file bytes and original navigation flow; it does not establish cross-peer P2P.

Runtime support references: [official Node releases](https://nodejs.org/dist/index.json)
and [Node support schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
