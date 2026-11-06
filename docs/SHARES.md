# Anonymous shares

Files use one global Share per normalized BitTorrent v1 infoHash. Hex and base32
hashes normalize to lowercase hex; tracker parameters and magnet query order do
not create another Share. A Share stores the magnet and original file metadata,
a token of 1–6 digits, and `lastAccessedAt`. It has no owner, uploader, account ID, or
reverse reference to personal files. Publishing the same torrent reuses its
Share and token; it never replaces the original metadata. New tokens start with
one random one-digit candidate. If it is occupied, allocation tries one random
two-digit candidate, then three digits, up to six. Each collision increases the
length immediately, even if other codes of the same length are still free. If
all six candidates collide, allocation removes the live Share with the earliest
`lastAccessedAt` across both files and texts and reuses its token. This selection
is global, not limited to the six colliding candidates. The old Share and its
alias are replaced atomically; an intervening access causes selection to retry.
New random candidates do not add leading zeroes; `0` is a valid one-digit code.
Reused tokens retain their exact spelling, including older codes with leading
zeroes. Other existing Shares keep their tokens unchanged.

Pasting a token starts receiving immediately. Typed tokens of one to five digits
wait for Enter; a complete six-digit token starts after a short pause. This keeps
a short token from being received while the user is still typing a longer one.

A personal File lives in browser local storage (`w2w.files.v1`): its local ID,
`shareId`, display name, notes and favorite are private to that browser. A cached
public Share and local seed/receive direction support display without creating
ownership. Removing a File (and its local Undo) never changes the Share. Login
is optional and does not sync, migrate or associate personal files with accounts.
Clearing site storage removes that browser's personal records.

Before hashing finishes, a random local draft ID provides `/files/:id/edit`.
There is no server draft or provisional token. Publishing a valid magnet binds
the local File to its canonical infoHash and changes the page URL to
`/files/:infoHash`. This URL works in another browser. The short token is an
atomically allocated alias of that same Share, not a second file identity.

Text uses a single TextShare: random stable ID, content, token and
`lastAccessedAt`. Anyone with its link can read or edit. Equal content does not
merge documents. There are no user collections, personal titles, notes or
favorites. The editor label is derived from content; its language selection is
a temporary view preference. Close leaves the document available to others.

Both kinds expire after 30 days without effective access. Publishing, explicit
receiving/viewing and saving text renew the Share and token together. Sidebar
refreshes, GET metadata, router preload/revalidation and peer heartbeats do not.
Redis Lua operations make existence checks, updates and expiry atomic; a late
read or save cannot resurrect an expired Share. Personal Files remain visible
as expired after the resource disappears. Short tokens can be reused after
expiry or collision-driven eviction. Eviction also removes the old Share's
canonical URL; it does not remove browser-local Files or stop an ongoing peer
transfer. A token is a convenience code, not authentication or an encryption
secret.

Only the six-collision fallback scans Share records, in batches outside Lua to
avoid blocking Redis for a full-database scan. The final Lua operation rechecks
the requested Share, candidate availability, the victim's last access time and
its alias before replacing anything. No new age field or Redis index is needed.

## API examples

No session cookie is needed. Replace the example infoHash with a real torrent's
hash and metadata. These commands target a local development server.

```bash
curl -X POST http://127.0.0.1:5173/api/new/token \
  --data-urlencode 'intent=acquireToken' \
  --data-urlencode 'magnet=magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' \
  --data-urlencode 'filename=example.txt' --data 'filesize=12&filetype=text/plain'
curl 'http://127.0.0.1:5173/api/files?shareId=0123456789abcdef0123456789abcdef01234567'
curl -X POST http://127.0.0.1:5173/api/files \
  --data 'intent=access&shareId=0123456789abcdef0123456789abcdef01234567'
curl -i -X POST http://127.0.0.1:5173/api/new/text
```

`acquireToken` returns `{share, shareId, fileId, token, magnet, type, intent}`;
`fileId` is a compatibility alias of the canonical `shareId`. `acquireMagnet`
accepts a token of 1–6 digits and returns the same file fields or `{type:"text",
textId}`. `GET /api/files` and POST `intent=access` return `{share}`; an expired
or missing ID returns 404. Personal edits and deletion have no server mutation.

## Deployment and old data

This version starts a new Redis namespace: `w2w:v2:share:file:*`,
`w2w:v2:share:text:*`, and `w2w:v2:token:*`. Previous user histories and old token
links are intentionally not migrated. No deployment-time flush or full-database
scan is required. Existing `user:*`, `unifiedTokenMap`, and undo keys may remain
in Redis, but the application neither reads nor updates them. Optional login
challenge keys remain separate from Share data.

If a complete database reset is desired, stop application writes, verify the
Redis instance/database belongs exclusively to W2W, and reset that database with
`redis-cli -h <verified-host> -p <verified-port> -n <verified-db> FLUSHDB`, then
restart the application. This destroys legacy data and current Shares; it is
not a migration step and must not target a shared Redis database. Browser local
Files are independent and are not removed by a server reset.
