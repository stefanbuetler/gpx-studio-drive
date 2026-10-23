# Licensing and credits

trail-explorer is an independently maintained fork of gpx.studio. The GPX editor
is credited to gpx.studio and its original authors and contributors. The fork adds
GDrive cloud-file workflows, public route links and iframe embeds.

## Notices included

- Original root `LICENSE` is retained unchanged: MIT, © 2026 gpx.studio.
- The website serves that license at `/LICENSE.txt`.
- Account menu → About trail-explorer and the website footer credit the upstream
  project and link to the original source, fork source, and licenses.
- The build generates `/THIRD_PARTY_NOTICES.txt` from installed dependencies,
  including their available LICENSE/COPYING/NOTICE files (including the Inter
  font's OFL license). Platform-specific packages not installed are not included.
- Existing interactive map credits are retained. Static route previews preserve
  provider names and include the OpenStreetMap copyright URL where OSM is used.

## Findings that still require review

The MIT code license permits modification and distribution with its copyright
and permission notice. It does not establish rights to separate hosted services,
provider accounts, API keys, third-party content, or trademarks.

1. `website/src/lib/service-url.ts` and map styles still refer to the original
   gpx.studio routing, styles, and tile services. Confirm that independent-fork
   traffic is permitted, arrange permission, or use independently provisioned
   services. This review has not confirmed permission or found a prohibition.
2. Some map-layer definitions contain inherited provider keys. Check each
   provider's terms and key ownership before relying on them for this fork.
   Do not assume a public key in upstream source is licensed for independent use.
3. Map, terrain, imagery, and overlay providers have separate attribution,
   caching, screenshot, redistribution, and usage rules. Keeping their existing
   attribution is necessary but is not a complete review of those terms.
4. Lockfile declarations include OFL fonts and LGPL/MPL packages, largely native
   image/CSS build tooling, as well as permissive libraries. Generated notices
   help retain texts but are not a complete license-compatibility or distribution
   audit. Review obligations separately if shipping binaries or changed dependencies.
5. The new name/logo should identify this as an independent project. No formal
   trademark clearance for “trail-explorer” has been performed.

No claim of a full legal clearance is made by these checks.

Sources:
- https://opensource.org/license/mit
- https://www.openstreetmap.org/copyright
