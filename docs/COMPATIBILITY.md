# Runtime and dependency compatibility

This review covers the maintained application in `remix/`. The historical
`POC/` application is excluded. Release and rollback instructions are in
[RELEASE.md](RELEASE.md).

## Selected versions

| Component | Selected version | Reason |
| --- | --- | --- |
| Node / npm | 24.22.1 / 11.19.1 | Pin the tested LTS release in `.node-version`, the package engine range (`>=24.22.1 <25`), package-manager declaration and Docker image. Node 20 reached end of life on April 30, 2026. |
| Remix | 2.17.5 | Latest compatible Remix 2 patch; updates server/runtime security fixes together. |
| Vite | 6.4.5 | Necessary major update from Vite 5; Remix 2.17.5 explicitly supports Vite 5 or 6. |
| React / TypeScript | 18.3.1 / 5.9.3 | Remain within Remix's declared peer ranges. |
| React Router | 6.30.6; router 1.23.4 | Patch overrides address additional redirect fixes without changing the framework major or serialization protocol. |
| ESLint | 9.39.5 | Documented development-only exception: this major is deprecated, but the selected React/import/hooks plugins do not support ESLint 10. A separate coordinated tooling migration is needed. |
| WebTorrent / Monaco | 2.8.5 / 0.55.1 | Retain their API generations; browser behavior needs functional verification beyond installation. |

Other direct dependencies were refreshed within their existing major ranges.
Google authentication now uses `google-auth-library` 11.3.1 for verification;
its Node >=22 requirement is satisfied. The existing tar, DOMPurify and esbuild
overrides resolve to patched compatible versions. The lockfile records the exact
dependency graph. No `npm audit fix --force` or unsupported framework-major
override was used.

## Completed checks

| Check | Result |
| --- | --- |
| Dependency refresh followed by frozen `npm ci` | Passed on Node 24.22.1 / npm 11.19.1 |
| Native `node-datachannel` module load | Passed; this alone does not prove browser file transfer |
| `npm run typecheck` | Passed, zero errors |
| `npm run lint` | Passed, zero errors and warnings; vendored generated JavaScript is excluded from source linting |
| `npm run build` | Passed |
| HTTP and token storage regression suites | Passed: 15 substantive cases; Node runner reports 17 including two parent groups; isolated Redis and production processes |
| Updated Vite development startup and HTTP smoke | Passed |
| Chromium editor and file flow | Passed: Unicode/shortcut/empty saves, document switching, seeding, client navigation and 150 KiB byte-exact Blob download; final run had zero page errors |
| Docker build and runtime smoke | Passed: Node 24 image, non-root UID 1000, production dependencies only, health revision, text/file sharing and deletion/undo |
| Full peer-to-peer transfer across browser contexts | Not verified: local tracker signaling worked but transfer timed out under managed Chromium policy disabling non-proxied UDP; no policy bypass |
| Real Google OAuth login | Not run: no interactive credential flow; certificate/script domains are restricted in this cloud environment |
| Release/rollback scripts | Syntax and mocked control-flow checks passed; real server backup/restore and rollout not run |
| Production deployment and deployed-version health check | Not run; authorized SSH access, server coordination and private operational security review remain prerequisites |

## Dependency audit and remaining exposure

The baseline audit reported **49 vulnerable package entries**, including two
critical entries. After refresh, the full graph reports **19 entries** (zero
critical, 14 high, five moderate). `npm audit --omit=dev` reports **12 entries**
(zero critical, ten high, two moderate), arising from **four distinct
advisories**. These counts include transitive/meta-vulnerability entries; they
are not counts of independently exploitable application flaws. Audit commands
still return a nonzero result. The production image omits development
dependencies; that does not remove the remaining production advisories.

| Advisory | Inspected application path and limitation |
| --- | --- |
| [GHSA-rxv8-25v2-qmq8](https://github.com/advisories/GHSA-rxv8-25v2-qmq8), turbo-stream DoS | The advisory applies to Remix 2 with Single Fetch enabled. The generated application has `v3_singleFetch: false`, checked by an integration assertion; Remix gates `.data` handling and turbo serialization behind this flag. The affected feature is currently disabled, but the dependency itself is not patched. Do not enable it without reassessing this advisory. |
| [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6), navigation redirect bypass | Current navigation destinations use fixed internal file/text paths and generated IDs, including restore responses. No raw user URL or `returnTo` navigation sink was found. Preserve that constraint; this is an application-path assessment, not a package-level fix. |
| [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg), SSR error constructor injection | Production Remix sanitizes actual `Error` instances to ordinary errors. Application code does not overwrite error subtypes or throw user-supplied serialized error objects. No reachable injection path was identified; changes to error handling require reassessment. |
| [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp), `ip.isPublic` SSRF classification | The remaining installed `ip` use is in the tracker's UDP server parser, which calls `toString`, not `isPublic`. This app runs the browser WebTorrent bundle through a `.client` module and does not start a tracker server during SSR. The package remains vulnerable; the inspected application does not use the affected classification path. |

This is a compatibility update with documented residual advisories, not a
zero-audit release. Removing the remaining framework advisories requires a
separately tested React Router >=7.18 migration. Forcing turbo-stream 3 into
Remix 2 would change its pinned serialization protocol and was rejected.
Likewise, npm's suggested WebTorrent downgrade to 0.7.3 is not an acceptable
fix; WebTorrent 3 also retains the affected `ip` dependency chain.

The review used the [official Node release index](https://nodejs.org/dist/index.json),
[Node support schedule](https://github.com/nodejs/Release/blob/main/schedule.json),
published npm package peer/engine metadata, and the linked advisories. Node 24
is supported through April 30, 2028. Re-run both audit scopes and the release
checks when dependency versions, feature flags or deployment configuration
change.

Browser note: one earlier run reported a Monaco `Canceled` page error when leaving the editor, without a functional failure; the final stack-capture rerun did not reproduce it. Its cause is unconfirmed. Remix 2 also rejects cross-origin document-form actions before application code with an empty HTTP 500; application fetcher actions explicitly return 403 for invalid login origins, covered by tests.
