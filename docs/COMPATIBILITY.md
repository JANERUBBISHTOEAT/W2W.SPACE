# Runtime, dependency migration and verification

This report covers the maintained application in `remix/` and its committed
lockfile. The historical `POC/` package is outside this runtime and audit scope.
Deployment and rollback procedures are in [RELEASE.md](RELEASE.md).

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
| Complete application regression suite | Passed: 22 tests, including the 3 IP tests; zero failures, skips or cancellations |
| Browser validation | Passed: 8 checkpoints, zero page errors |
| React Router 7 Docker build and runtime smoke | Passed: health reports tested revision `candidate-router7`; UID 1000; no `.env` or Vite in the runtime image; text create/save/token/delete/undo and file metadata/token/SSR/cleanup flows pass |
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

Runtime support references: [official Node releases](https://nodejs.org/dist/index.json)
and [Node support schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
