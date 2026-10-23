# File and cloud UX

Feature branch: `codex/gdrive-ux`. Published to production on 2026-10-23;
Git `main` remains unchanged.

Production Worker version: `5fd2eb71-5530-483b-b70b-ddf8547b3e57` (100% traffic).
Previous stable version for rollback: `17c9ae3a-d9d6-4d2e-8039-f3f224688187`.
Both `gpx.trailexplorer.net` and the original production `workers.dev` hostname
were checked for HTTP availability, persistent GDrive configuration, and matching
release asset/license checksums. Existing secrets, routes, and share-link storage
were retained.

The latest release also fixes production GraphHopper routing and elevation fetches
through fixed same-origin Worker endpoints, and repairs Water POI requests,
loading/error feedback, drinking-water tag coverage and tile queuing. Live checks
on both production hosts returned 19 routed points with elevation, a valid WebP
elevation tile, 90 water sources in a public Zurich test area, and persistent
GDrive configuration. Worker fetches use manual redirect handling (the Workers
runtime does not support `redirect: 'error'`); unexpected redirects are rejected.

The File menu contains New, Open, Save, Save as, Share (cloud files only), and
Close. Open and Save as offer This device or GDrive. The account menu
connects or disconnects GDrive and provides project credits under About.
File context menus are shortcuts to the same
operations. Ctrl/Cmd+O, Ctrl/Cmd+S, and Ctrl/Cmd+Shift+S follow the same flows.

| File state | Save | Share |
| --- | --- | --- |
| Local | Ask for This device or GDrive | Hidden |
| Writable app-owned GDrive copy | Update the same remote file | Share its saved version |
| Other GDrive original | Choose a folder and save a separate editable copy | Drive permissions apply; suggest saving a copy if unavailable |
| Cloud file with edits | Save changes; show an unsaved marker until successful | Ask to save changes first |

Saving a local file to GDrive reclassifies the existing working copy into
Cloud files → GDrive. It retains its identity, selection, map position, and undo
history, rather than closing/reimporting and creating a second editor entry.
Cancelled or failed saves leave the local copy intact. No GPX Files folder is
created or selected automatically. The save dialog asks for a folder and filename
and supports creating a folder. Save as always creates a new destination copy.

Cloud source metadata is stored with the working copy and scoped by file identity
and Google account. Disconnecting or reloading keeps the cloud classification.
Duplicating or copying a file clears the cloud association. Local working files
are still available offline; Google access is needed to save or share them.

Both storage groups use the existing file tree and selection behavior. Reordering
one group preserves the other group's order. Dragging between storage groups
does not upload or download files implicitly. Use Save as to choose a destination.

Link and embed generation only changes sharing permissions on an existing GDrive
file. It never uploads local edits implicitly. Public access still requires the
explicit confirmation in the Share dialog; preview images use the saved GPX.
