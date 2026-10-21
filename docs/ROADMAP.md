# GPX Studio Drive — development roadmap

This fork of [gpx.studio](https://github.com/gpxstudio/gpx.studio) adds Google Drive storage, import from URL, and geographic discovery. Keep upstream functionality intact and compatible where possible.

## Architecture decisions
- SvelteKit static frontend hosted on Cloudflare Pages.
- Google Drive is the source of truth for GPX files. Local IndexedDB is an offline cache and rebuildable index.
- No central application backend or database for the initial release.
- Google OAuth via Google Identity Services with the least-privileged practical scope (prefer `drive.file` and Google Picker for user-selected files). Do not commit credentials.
- Geographic metadata uses stable identifiers and distinguishes places *on* a route from nearby places.
- All file import paths validate GPX contents and enforce size limits. Remote URL import is public HTTPS-first; no open proxy or unrestricted SSRF.
- Treat every autosave conflict as user-visible; do not silently overwrite files.

## Milestones

### M0 — Working fork and deploy
- [ ] Configure Cloudflare Pages project with GitHub integration.
- [ ] Build GPX package: `cd gpx && npm ci && npm run build`.
- [ ] Build site: `cd website && npm ci && npm run build`. Set `PUBLIC_MAPTILER_KEY` at build time.
- [ ] Verify maps, GPX editing, import/export, and PWA behaviour on deployed URL.
- [ ] Add PR checks for type checking, build, and lint; keep `main` stable.
- [ ] Register required map/routing API origin restrictions and review external service quotas.

### M1 — Google Drive manual save/load
- [ ] Register Google Cloud OAuth web client; configure authorised JavaScript origins for local and production URLs.
- [ ] Connect/disconnect account with consent; use `drive.file` and Picker for existing files.
- [ ] Upload current GPX to a user-selected folder, open selected file from Drive, update the same Drive file.
- [ ] Persist Drive file ID to local GPX entry mapping and indicate sync status.
- [ ] Handle expired tokens, revoked permissions, offline connectivity and duplicates.

### M2 — Sync reliability
- [ ] Debounced save with explicit unsaved changes indicator.
- [ ] Detect remote revision before writing; offer conflict resolution.
- [ ] Incremental metadata refresh, pagination and resilient retries.
- [ ] Verify multi-device edits, Drive rename/move and offline recovery.

### M3 — Import by URL
- [ ] Paste HTTPS link to direct GPX file.
- [ ] Validate content type and actual GPX structure; limit downloads.
- [ ] Support encoded deep links to open an imported route.
- [ ] Add provider-specific link resolvers only as needed and legally permitted.
- [ ] If a CORS workaround is needed, use a restricted proxy with host and size protections, not a public open proxy.

### M4 — Searchable geographic library
- [ ] Route metadata: activity, countries, regions, places, summits, start/end, distance, ascent, tags, source.
- [ ] Store route catalogue as versioned metadata backed up in Drive; IndexedDB for query and cache.
- [ ] Enrich coordinates via appropriately licensed/geocoding providers with caching and rate limits.
- [ ] Full text and facet search; map viewport/route intersection search.
- [ ] Bulk import, deduplication, progress indicators, and background-free resumable indexing.

### M5 — Publishing
- [ ] Shareable read-only links for chosen public GPX tracks.
- [ ] Adventure blog embed and optional MapDirector video integration.
- [ ] Keep private Drive URLs and OAuth access tokens out of public pages.

## Contribution workflow
- Branch from `main` for each focused change.
- Open PR, run checks, test manually on preview, then squash merge.
- Keep the upstream remote and periodically merge upstream updates after reviewing conflicts.

## Next action
Deploy the unchanged application first. Cloudflare Pages build output is `website/build` and the static adapter is configured in `website/svelte.config.js`. The `gpx` workspace must be built before the website. Choose a build command that builds both from the repository root or add a script to do so.
