# Local development and GDrive

Use Node.js 24 (`.nvmrc`); the locked website dependencies require Node.js 22 or newer.

```sh
nvm use
npm ci --prefix gpx
cp website/.env.example website/.env
# Set PUBLIC_MAPTILER_KEY in website/.env.
npm ci --prefix website
npm run dev --prefix website -- --host localhost --port 5173 --strictPort
```

Open http://localhost:5173/app and choose **File → Open from GDrive**. The modal connects Google, searches GPX files, and opens routes in the native editor. Select one or more routes individually, then choose **Done** to edit. The right-hand file tree contains local working copies only. Drive session state and open-file links stay alive when the tree is hidden; opening the modal does not require enabling the tree. File discovery starts on demand. A GPX metadata index persists in IndexedDB across page reloads, separated by the verified Google account, OAuth client, and permission scope. Cached results appear immediately after session/account verification; Google’s change feed updates them in the background without disabling search or opening files. Refresh Drive checks changes manually. Reopening the modal checks for updates at most once per minute. The first scan, changed shared-drive membership, or a rejected change cursor requires a full scan. Failed background updates keep the saved list usable and show a retry notice; inaccessible files still fail the live metadata check when opened. Disconnect clears the saved index. If browser storage is unavailable, browsing works with an in-memory index for the current session. Only file metadata and change cursors are indexed; no OAuth credentials or GPX contents are stored in the index.

`website/.env` is ignored. `PUBLIC_GOOGLE_CLIENT_ID` can override the branch's existing public OAuth client ID. Do not put a client secret in the browser application.

## Routing, maps, and elevation on localhost

The public gpx.studio services do not send browser CORS permission for localhost. During `npm run dev`, requests to the routing, style, and tile services use fixed same-origin `/__gpx_services/` paths handled by Vite's development proxy. This covers both application fetches and MapLibre resource requests. POI requests use `/api/pois`, proxied to the fixed Overpass service during development and handled by the Worker in production. Only the configured upstream hosts are proxied; production also uses fixed same-origin routes for GraphHopper and elevation tiles, since those upstreams do not allow the trail-explorer origin. Styles and other map resources retain their original production URLs. Keep the dev server bound to localhost.

## Google configuration

Enable the GDrive API in the OAuth client's Google Cloud project. Register `http://localhost:5173` under **Authorized JavaScript origins** for that exact Web application client. A redirect URI is not a substitute for a JavaScript origin. Add the testing account to the consent screen's test users if necessary. Google may take time to apply saved configuration changes.

The initial connection requests `drive.file`, keeping access tokens in memory. This lists files created or already authorized for this application. Save a local route from its context menu to create an accessible copy in GPX Files.

Choose **Search all Drive** to add `drive.readonly`. Google grants read access to all Drive files for this feature, though this app lists only GPX routes and downloads a route only when it is opened. The original app-file connection remains usable if the added permission is declined. The grant is remembered by the persistent session and renewed without requesting broader write access.

Discovery scans metadata pages in My Drive and enumerates each accessible shared drive, including pagination of the shared-drive list. It deduplicates file IDs, excludes trashed items, folders and shortcuts, and identifies routes by case-insensitive `.gpx` suffix or `application/gpx+xml` MIME type. Metadata scanning avoids the Drive query `name contains` prefix limitation, which can miss extension matches. Text in the search box filters the complete GPX result list locally. Incomplete searches produce an error instead of a success claim.

All routes open as editable local working copies. The app never needs account-wide write access: Save creates an app-owned copy in **GPX Files**, and Share publishes that saved copy. Whole-Drive discovery uses Google's restricted `drive.readonly` scope; review Google's app-verification requirements before any future public release.

## File operations

Imported files use a meaningful GPX metadata title, then the first named track/route, then the source filename without `.gpx`. Generated defaults such as `New file 2` and `Neue Datei 1` are skipped when a better name exists. The tree applies the same track-name fallback to already-open files. If an old local copy contains only default internal names, reopen its source to recover the filename; old copies do not retain that source filename.

- Choose **File → Open from GDrive**, search the cached index, and select a route to open a local working copy. Repeated clicks select that copy while it remains open.
- Edit locally, then right-click the local file and choose **Save to GDrive**. The first save creates a private copy inside an app-owned **GPX Files** folder in My Drive. Imported originals are preserved.
- Later saves update the same managed copy, including its name. Unchanged copies do not produce a file write. Opening an existing managed copy reconnects it as a save destination.
- Save links persist in IndexedDB across reloads and are scoped to the verified Google account, local file ID, and a unique working-copy identity. Deleted or duplicated local files cannot overwrite an unrelated saved route. Disconnect leaves local copies and their saved associations available for a later connection to the same account.
- Save checks the destination modification time captured when opening or saving. Refreshing the browser index does not replace that baseline. An exposed ETag also supplies `If-Match` to reject a concurrent modification; without one, a window remains between the metadata check and upload.
- On conflict, export local edits as a backup, close the local copy, and reopen the saved Drive file to review the latest version. Import the backup as a separate working copy if both versions are needed. A deleted destination is recreated on the next save.
- GPX uploads, downloads, and updates validate XML and enforce a 30 MiB limit.
- A 401 or expired access token returns the controls to sign-in; local files remain available. A blocked or closed OAuth popup releases the busy state.

With the session service configured below, GDrive reconnects when the page reloads. Local editor files and their saved-copy associations use browser IndexedDB. If optional association storage is unavailable, the app warns that the save link lasts only for the current session.

## Persistent Google sessions

The Worker uses Google's authorization-code flow. Copy the repository-root `.dev.vars.example` to `.dev.vars`, supply the OAuth **client secret**, and generate a random 32-byte session encryption key (64 hexadecimal characters). These are server-only settings, separate from `website/.env`. Both secret files are ignored by Git. Set `GOOGLE_CLIENT_ID` here too when overriding the default OAuth client. Never give these secrets a `PUBLIC_` prefix.

The Vite development plugin runs the same session handler on localhost. It reads `.dev.vars` on each request, so secret changes do not require another local server. Cloudflare runs `worker/index.ts` and sends `/api/drive/*` to the Worker before static assets; other paths keep using the static website.

On sign-in, the browser sends Google's one-time authorization code to the same-origin backend. The backend exchanges it with Google and encrypts the refresh credential in a host-only, HttpOnly, SameSite=Lax cookie. HTTPS cookies also use Secure. Origin and custom-header checks protect all session mutations against CSRF. Client secrets and refresh tokens are never returned to browser JavaScript; short-lived access tokens remain in memory. Nothing writes tokens to localStorage, sessionStorage, or IndexedDB.

Reloading or remounting the tree restores access through the cookie. Requests renew expired access automatically. Disconnect revokes the Google refresh credential and clears the cookie; local working copies remain. Revoked/expired grants return to sign-in without repeated popups. Temporary Google outages preserve the existing session for retry.

The session lasts for 30 days of inactivity, bounded by any expiry Google supplies. Google sign-out elsewhere does not itself revoke an app's authorization. Google can expire or revoke refresh credentials independently; external OAuth apps in Testing status can receive refresh tokens that expire after seven days. Users then need to sign in again. The session-only token flow remains available when no server secrets are configured.

For the isolated feature preview, upload `GOOGLE_CLIENT_SECRET` and `DRIVE_SESSION_SECRET` using the preview's `--secrets-file` option or `wrangler preview secret bulk --name feature-google-drive-integration`. These commands target the **preview**, not production. Keep the session encryption key stable across preview uploads so existing cookies remain readable, and restrict `DRIVE_ALLOWED_ORIGINS` to the exact app origins. Do not upload `.dev.vars` as a website asset.

## Public route links

Set `GOOGLE_PUBLIC_API_KEY` in the ignored `.dev.vars` and in Cloudflare Worker secrets. Sharing and embedded viewers load this restricted public browser key from `/api/drive/public-config`, so automated builds do not need a duplicate browser-key variable. `PUBLIC_GOOGLE_API_KEY` remains an optional fallback for standalone static hosts. Set `PUBLIC_APP_URL` in the ignored `website/.env` before building. The app URL must be the public HTTPS address where this build will run. These are public browser settings; never use a client secret or an OAuth access token here.

Create an API key in the same Google Cloud project, restrict its API access to **GDrive API**, and restrict its websites to `http://localhost:5173/*` and the exact preview hostname followed by `/*`. A version's unique Cloudflare hostname needs its own website restriction if you use it instead of the preview alias. Rebuild after changing environment settings.

Right-click a local file and choose **Share route**. Review the dialog, then choose **Make public and create link**. The app first saves the current local route to its managed copy in **GPX Files**, grants anyone-with-the-link reader access to that copy, and verifies an anonymous download before displaying the link. The imported source is preserved. Cancelling the dialog performs no Drive writes. Existing public reader access is reused; broader public access must be corrected in GDrive first.

The modal's **Sign in with Google** button performs Google sign-in and Drive authorization together. There is no separate app account. With the persistent session service enabled, returning users reconnect automatically. Google still decides when fresh authorization is required.

The result includes **Copy link** and **Copy embed code**. Paste the iframe HTML into another website; it uses 100% width and a configurable 500-pixel height. Generated embeds use `/embed?...&fit=route`, which fits the route to the iframe rather than inheriting an editor hash. Existing embed URLs keep their previous hash behavior.

Both formats snapshot the current basemap, active overlays and their opacities, points-of-interest queries, active custom/extension layer definitions, distance and direction markers, distance/speed/temperature units, resolved light/dark theme, line width/opacity defaults, terrain source, map pitch/bearing, and elevation visibility, height, fill, and additional datasets. The snapshot travels in the URL and does not depend on the recipient's saved preferences. View settings are fixed when a link is created; route content still follows later Drive saves. Generate a fresh link/code after changing the presentation. Custom layer URLs are public in this output and should use public tile sources. Basemaps excluded by the existing embedding policy (currently Ordnance Survey) produce an explicit error before changing Drive permissions.

The `/share?id=...` page displays the track without a Google sign-in. Its link contains the file ID and, when required, its Drive resource key. It contains no OAuth token or API key. Recipients can view and download the route; opening it in the editor creates their own local copy. Subsequent owner saves update what the link displays. Revoke public access in GDrive to disable the link. Treat the link as public even though the viewer asks search engines not to index it.

An owner may share only files available under this app's `drive.file` access. Test with a synthetic route before publishing personal location data.

### Preview upload

After the local checks and build pass, an explicitly authorized branch preview can be uploaded with `wrangler preview --name feature-google-drive-integration`. The repository's `previews` configuration selects Cloudflare's isolated Worker Previews workflow. Use the preview hostname configured in the Google API key and `PUBLIC_APP_URL`.

`wrangler versions upload --preview-alias ...` creates an undeployed production Worker version instead. An existing isolated preview can take precedence at the same hostname, so that command may leave the branch preview serving an older build. Do not run `wrangler deploy` or `wrangler versions deploy` for preview testing.

## Verification

```sh
npm run build --prefix gpx
npm run check --prefix website
npm run build --prefix website
cd website
npx playwright install chromium
npm run test:drive
npm run test:session
```

The Playwright suite starts or reuses a local Vite server. It intercepts Google Identity and Drive requests and never writes to a real Google account. It covers pagination/filtering, import into the native tree, metadata edits through the actual editor, managed-folder creation, unchanged saves, persisted copy updates, remote conflicts (including HTTP 412), invalid GPX, expired sessions, cancelled OAuth, stale links after local deletion, and HTTP 403 recovery. It also tests local routing requests, explicit sharing confirmation and cancellation, public reader reuse, permission errors, anonymous viewing with resource keys, revoked links, and invalid viewer URLs.

The build commands produce local static output only. Keep changes on the feature branch and never push to `main` as part of this workflow. Preview uploads require separate authorization; production deployment is outside this workflow.


## Local file controls and account display

The Local files header offers separate **Save all to GDrive** and **Close all local files** icon buttons. Save uploads every open working copy to GPX Files and leaves them open. A failed save preserves the local copies; files already saved remain on GDrive. If a route changes during the batch, save again to upload its latest edits. Close works independently, including while disconnected, and closes local copies without writing to GDrive. Its notification offers Undo to restore the copies; the editor's normal undo history also supports restoring them. Closing is disabled during a save.

Clicking a local file centers its selected route. Clicking the selected file again recenters after panning. Clearing selection fits all open tracks. Empty tracks do not produce invalid map bounds.

The toolbar shows the connected Google user's name, with their email in the tooltip. Clicking it opens the GDrive controls; signed-out users see Sign in. Profile display uses the existing GDrive About endpoint and existing permissions, with no additional OAuth scope or profile persistence. The current app design remains unchanged.


**File → Save to GDrive** saves the file containing the current selection. It is disabled when no file or multiple files are selected. **File → Save all to GDrive** saves all local working copies. Both work with the right-hand file tree hidden and leave working copies open. Existing export commands keep their download shortcuts.

Delete and Delete all remove local content only. Both show an Undo action after the operation completes, as do context-menu and keyboard deletions. Existing saved GDrive files remain untouched.

## Short public links

Sharing creates a random `/s/<code>` URL backed by the feature preview’s Cloudflare D1 database. The record contains only the public GDrive file ID, resource key, and presentation settings. It never stores OAuth tokens or GPX content. The same code with `?embed=1` opens the centered embed. Existing long links still work.

Creation requires this app’s Google access token and an already-public app-managed route. Links continue to read the live GDrive file, so making that file private prevents public viewing. Local development uses the configured `PUBLIC_APP_URL` preview service. Production requires its own `SHARE_LINKS` binding and the schema in `worker/migrations/0001_share_links.sql`; the current binding is preview-only.

New short links include server-rendered Open Graph metadata and a 1200×630 JPEG snapshot of the shared route, rendered from the public saved GPX in an isolated map. Other local files are excluded. The image includes the route name, distance/ascent, and map attribution. Tile failures fall back to a route outline. `GOOGLE_PUBLIC_API_KEY` is the existing public viewer key, also supplied as a Worker secret, so the server can check anonymous GDrive access before serving the page or image. Revoking public file access hides previews (previously cached messaging images can remain). Recreate older links to get a fresh preview; images and view settings are captured when sharing.
