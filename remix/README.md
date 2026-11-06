# W2W development

The maintained React Router 7 application uses Node 24.22.1 (see `../.node-version`), npm 11.19.1, and Redis.

```bash
cd remix
npm ci
mkdir -p .cache/redis
redis-server --bind 127.0.0.1 --port 6379 --dir "$PWD/.cache/redis" --appendonly yes
```

In another terminal in `remix/`:

```bash
NODE_ENV=development REDIS_HOST=127.0.0.1 REDIS_PORT=6379 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

The Windows Redis configuration in `app/` uses a different port; use the explicit local settings above. Anonymous development requires no Google credentials. Development generates a per-process session secret if `SESSION_SECRET` is absent, so cookies reset when the server restarts.

## Validation

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

Tests start isolated Redis and production app processes, choose temporary ports/data directories, and clean up afterward. They do not use or flush your development Redis. Set `REDIS_SERVER` to the absolute Redis binary/wrapper path when it is not on PATH. Build before testing so HTTP checks exercise the current server artifact.

Browser regressions also exercise Chromium and WebKit responsive layouts, real
file seeding, and sidebar resizing:

```bash
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The WebKit seeding check uses a fresh, temporary persistent profile because
[OPFS is unavailable in ephemeral WebKit contexts](https://github.com/microsoft/playwright/issues/18235#issuecomment-1292744784).
It still uses real file storage and WebTorrent; the profile is removed after the test.

Application and editor styles live in `app/styles/` and are linked through Vite
asset URLs, so deployments change the URL when the CSS changes.

`npm start` runs the production build. Supply `SESSION_SECRET` securely (at least 32 characters) and Redis connection settings; production refuses the old public fallback secret. `/health` checks Redis and returns the embedded `APP_REVISION`. Production uses `server.mjs`; behind HTTPS termination, configure verified immediate proxy addresses in `TRUSTED_PROXY_CIDRS` and ensure the proxy overwrites forwarding headers. Untrusted peers cannot spoof protocol/host/port. Google login additionally needs the correct `GOOGLE_CLIENT_ID` and HTTPS access to Google's certificate endpoint. Browser WebTorrent requires a secure context (HTTPS or localhost) and working peer/tracker connectivity.

Routes are registered explicitly in `app/routes.ts`; add new route modules there so their URLs and IDs remain part of the application.

The npm scripts target the Linux development/deployment environment. Use WSL or an equivalent POSIX shell on Windows.

See [compatibility and residual dependency advisories](../docs/COMPATIBILITY.md) and [release/rollback procedures](../docs/RELEASE.md). Container builds use the committed lockfile, exclude local secrets, and run as an unprivileged user. Do not use the historical cleanup/deployment commands to stop the entire host or prune rollback images.

The [anonymous Share model](../docs/SHARES.md) documents canonical infoHash IDs, local personal files, explicit access renewal, API examples and the new Redis namespace. Google login is independent of shares and does not sync local file records.
