# Trail-explorer domain

`https://gpx.trailexplorer.net/app` is the production app on the
`gpx-studio-drive` Worker. Git `main` is unchanged by manual deployments.

Cloudflare is authoritative for `trailexplorer.net`; GoDaddy holds the nameserver
delegation. Existing Tophost records were copied and remain DNS-only.

Build from `website/` with `PUBLIC_APP_URL=https://gpx.trailexplorer.net npm run build`.
Deploy production using `wrangler.jsonc`. Its custom domain is recorded in that
configuration so later deployments retain it. Production and the existing
feature preview use the existing `SHARE_LINKS` database to preserve links already
issued on both addresses. Records are scoped to their originating hostname.

Feature deployments use `wrangler preview --name feature-google-drive-integration`
and remain at their `workers.dev` URL. Build them with
`PUBLIC_APP_URL=https://feature-google-drive-integration-gpx-studio-drive.stefan-buetler.workers.dev`.
Keep their origins and bindings in the `previews` configuration. Never attach the
production custom domain to a feature Worker. The temporary `trail-explorer`
Worker is no longer the deployment target for the custom domain.

The three server secrets are `DRIVE_SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, and
`GOOGLE_PUBLIC_API_KEY`. Keep them in ignored local files or Cloudflare secrets.
Do not upload the localhost `DRIVE_ALLOWED_ORIGINS` override. Production accepts
`https://gpx.trailexplorer.net` and its original `workers.dev` address; the feature
preview keeps its own allowed origin. For subsequent deployments preserve the
production session and client secrets rather than uploading local development
overrides.

Google OAuth must allow the JavaScript origin `https://gpx.trailexplorer.net`.
The public-viewer Drive API key must allow `https://gpx.trailexplorer.net/*`.
Users sign in again on the new hostname because session cookies and local
working files belong to each browser origin.
