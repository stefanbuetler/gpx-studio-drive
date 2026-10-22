<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import {
        driveBrowserOpen,
        driveFolderOpen,
        driveLocalActions,
        driveAccount,
        driveBatchActions,
    } from '$lib/drive/browser';
    import { toast } from 'svelte-sonner';
    import { captureSharedView } from '$lib/drive/sharing';
    import { Button } from '$lib/components/ui/button';
    import { Cloud, LogIn, FileText, ChevronRight, Check, RefreshCw, Search } from '@lucide/svelte';
    import DriveFolderDialog from '$lib/components/DriveFolderDialog.svelte';
    import { readSaveFolder, writeSaveFolder } from '$lib/drive/save-folder';
    import DriveShareDialog from '$lib/components/DriveShareDialog.svelte';
    import { publicDriveURL, publicViewerURL, downloadPublicGPX } from '$lib/drive/public';
    import { onMount, onDestroy, untrack } from 'svelte';
    import {
        DriveClient,
        DriveIndexReset,
        type DriveIndex,
        type DriveGPXFile,
    } from '$lib/drive/client';
    import { loadFile, fileActions } from '$lib/logic/file-actions';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { selection } from '$lib/logic/selection';
    import { boundsManager } from '$lib/logic/bounds';
    import { buildGPX, type GPXFile } from 'gpx';
    import { getGPXName } from '$lib/logic/file-name';
    import {
        localSaveIdentity,
        savedRouteKey,
        readSavedRoute,
        writeSavedRoute,
        contentHash,
        type SavedRoute,
    } from '$lib/drive/saved-routes';
    import { readDriveIndex, writeDriveIndex, clearDriveIndexes } from '$lib/drive/index-cache';

    const drive = new DriveClient(
        import.meta.env.PUBLIC_GOOGLE_CLIENT_ID ||
            '1029721603429-0h1hv3datbk3guc18kq8ta2od0gevqi4.apps.googleusercontent.com'
    );
    onMount(() => {
        void drive.prepare().catch(() => {});
        void action(async () => {
            if (await drive.restore()) {
                connected = true;
                status = 'GDrive connected';
                driveAccount.set({});
                // Profile details are optional; browsing still verifies the account separately.
                await drive.accountKey().catch(() => {});
            }
        });
        let previousIds = new Set<string>();
        return fileStateCollection.subscribe((localFiles) => {
            for (const [remoteId, link] of Object.entries(links)) {
                if (previousIds.has(link.localId) && !localFiles.has(link.localId))
                    delete links[remoteId];
            }
            previousIds = new Set(localFiles.keys());
        });
    });
    let saveFolderName = $state('GPX Files');
    let folderReady = $state(false);
    let shareFile = $state<DriveGPXFile | null>(null);
    let shareOpen = $state(false);
    let shareLocalId = $state('');
    let connected = $state(false);
    let allDrive = $state(false);
    let busy = $state(false);
    let error = $state('');
    let status = $state('');
    let files = $state<DriveGPXFile[]>([]);
    let links = $state<Record<string, { localId: string; identity: string }>>({});
    let query = $state('');
    let listed = $state(false);
    let syncing = $state(false);
    let cacheMessage = $state('');
    let indexedAt = $state(0);
    let indexKey = '';
    let activeIndex: DriveIndex | undefined;
    let indexEpoch = 0;
    let revision = 0;
    let attemptedAt = 0;
    const localUpdates = new Map<string, { file: DriveGPXFile; revision: number }>();
    $effect(() => {
        if (
            $driveBrowserOpen &&
            connected &&
            listed &&
            indexedAt &&
            !busy &&
            !syncing &&
            Date.now() - attemptedAt > 60000
        ) {
            void backgroundSync();
        }
    });
    $effect(() => {
        if ($driveBrowserOpen && connected && !busy && !listed) {
            listed = true;
            void action(async () => {
                await loadDriveFiles();
                status = 'GDrive connected';
            });
        }
    });
    $effect(() => {
        const actions: Parameters<typeof driveLocalActions.set>[0] = {};
        for (const [localId] of $fileStateCollection) {
            actions[localId] = {
                busy,
                save: () => {
                    void save(localId);
                },
                share: () => offerShare(localId),
            };
        }
        driveLocalActions.set(actions);
        driveBatchActions.set({
            busy,
            saveAll: () => {
                void saveAll();
            },
            disconnect: () => {
                void disconnect();
            },
        });
    });
    onDestroy(() => {
        ++indexEpoch;
        driveLocalActions.set({});
        driveBatchActions.set({ busy: false });
        driveAccount.set(null);
    });
    let filtered = $derived(
        files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    );

    async function action(operation: () => Promise<void>) {
        if (busy) return;
        busy = true;
        error = '';
        status = '';
        try {
            await operation();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            if (!$driveBrowserOpen) toast.error(error);
        } finally {
            connected = drive.connected;
            if (!connected) driveAccount.set(null);
            allDrive = drive.searchesAllDrive;
            busy = false;
        }
    }
    async function commitIndex(index: DriveIndex, epoch: number, startRevision: number) {
        if (epoch !== indexEpoch) return;
        const merged = new Map(index.files.map((file) => [file.id, file]));
        for (const update of localUpdates.values())
            if (update.revision > startRevision) merged.set(update.file.id, update.file);
        activeIndex = {
            ...index,
            files: [...merged.values()].sort((a, b) =>
                (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '')
            ),
        };
        files = activeIndex.files;
        indexedAt = activeIndex.updatedAt;
        const saved = await writeDriveIndex(indexKey, activeIndex);
        if (epoch === indexEpoch)
            cacheMessage = saved
                ? 'Local index up to date'
                : 'Index ready for this session; browser storage is unavailable.';
    }
    async function updateIndex(epoch: number, snapshot?: DriveIndex) {
        const startRevision = revision;
        let result: DriveIndex;
        try {
            result = snapshot
                ? await drive.syncIndex(snapshot)
                : await drive.buildIndex((scanned) => {
                      if (epoch === indexEpoch)
                          status = `Finding GPX files… checked ${scanned} files`;
                  });
        } catch (e) {
            if (!(e instanceof DriveIndexReset)) throw e;
            cacheMessage = 'Rebuilding local index…';
            result = await drive.buildIndex();
        }
        await commitIndex(result, epoch, startRevision);
    }
    async function backgroundSync() {
        if (!activeIndex || syncing) return;
        const epoch = indexEpoch;
        const snapshot = activeIndex;
        attemptedAt = Date.now();
        syncing = true;
        cacheMessage = 'Showing saved index · checking for changes…';
        try {
            await updateIndex(epoch, snapshot);
        } catch (e) {
            if (epoch === indexEpoch)
                cacheMessage =
                    'Could not update the index. Showing saved files; use Refresh GDrive to retry.';
        } finally {
            if (epoch === indexEpoch) {
                syncing = false;
                connected = drive.connected;
            }
        }
    }
    async function loadDriveFiles() {
        listed = true;
        connected = drive.connected;
        allDrive = drive.searchesAllDrive;
        const epoch = ++indexEpoch;
        syncing = false;
        attemptedAt = Date.now();
        const key = await drive.indexKey();
        if (epoch !== indexEpoch) return;
        if (indexKey !== key) {
            activeIndex = undefined;
            files = [];
            localUpdates.clear();
        }
        indexKey = key;
        const cached = await readDriveIndex(key);
        if (epoch !== indexEpoch) return;
        if (cached) {
            activeIndex = cached;
            files = cached.files;
            indexedAt = cached.updatedAt;
            cacheMessage = 'Showing saved index';
            void backgroundSync();
        } else {
            activeIndex = undefined;
            indexedAt = 0;
            cacheMessage = 'Building local GPX index · needed only for the first scan';
            await updateIndex(epoch);
        }
        status = `${files.length} GPX files found`;
    }
    function remember(file: DriveGPXFile) {
        const value = $state.snapshot(file);
        localUpdates.set(file.id, { file: value, revision: ++revision });
        files = [value, ...files.filter((f) => f.id !== file.id)];
        if (activeIndex) {
            activeIndex = {
                ...activeIndex,
                files: [value, ...activeIndex.files.filter((f) => f.id !== file.id)],
            };
            void writeDriveIndex(indexKey, activeIndex);
        }
    }
    function searchAllDrive() {
        return action(async () => {
            await drive.connect(true);
            if (!drive.searchesAllDrive)
                throw new Error(
                    'Google did not grant access to search all GDrive files. Your app-file connection is still available.'
                );
            await loadDriveFiles();
        });
    }
    function connect() {
        return action(async () => {
            await drive.connect();
            files = [];
            connected = true;
            await loadDriveFiles();
            status = 'GDrive connected';
        });
    }
    function refresh() {
        action(async () => {
            if (syncing) return;
            attemptedAt = Date.now();
            if (activeIndex) await updateIndex(indexEpoch, activeIndex);
            else await loadDriveFiles();
            status = `${files.length} GPX files found`;
        });
    }
    function open(file: DriveGPXFile) {
        return action(async () => {
            const existing = links[file.id];
            if (
                existing &&
                fileStateCollection.getFile(existing.localId)?._data.driveIdentity ===
                    existing.identity
            ) {
                selection.selectFile(existing.localId);
                status = `Already open: ${file.name}`;
                return;
            }
            const remote = await drive.getMetadata(file.id, file.resourceKey);
            const imported = await loadFile(await drive.download(remote));
            remember(remote);
            if (!imported) throw new Error('Could not read GPX file');
            delete imported._data.driveIdentity;
            const ids = fileActions.addMultiple([imported]);
            const identity = await localSaveIdentity(ids[0]);
            const snapshot = buildGPX(imported, []);
            links[file.id] = { localId: ids[0], identity };
            if (drive.isManagedRoute(remote)) {
                const account = indexKey.slice(0, indexKey.lastIndexOf(':'));
                await writeSavedRoute({
                    key: savedRouteKey(account, ids[0], identity),
                    account,
                    localId: ids[0],
                    identity,
                    remote,
                    folderId: remote.parents![0],
                    hash: await contentHash(snapshot),
                });
            }
            selection.selectFileWhenLoaded(ids[0]);
            boundsManager.fitBoundsOnLoad(ids);
            status = `Opened ${file.name}`;
        });
    }
    function localFilename(file: GPXFile) {
        const name = getGPXName(file) || 'Route';
        return name.toLowerCase().endsWith('.gpx') ? name : `${name}.gpx`;
    }
    async function ensureConnection(): Promise<string> {
        if (!drive.connected) await drive.connect();
        connected = true;
        allDrive = drive.searchesAllDrive;
        const account = await drive.accountKey();
        const nextKey = `${account}:${allDrive ? 'all' : 'app'}`;
        if (indexKey !== nextKey) {
            ++indexEpoch;
            syncing = false;
            indexKey = nextKey;
            activeIndex = await readDriveIndex(nextKey);
            files = activeIndex?.files ?? [];
            localUpdates.clear();
        }
        return account;
    }
    async function saveLocalToDrive(localId: string): Promise<DriveGPXFile> {
        const original = fileStateCollection.getFile(localId);
        if (!original) throw new Error('Local working copy not available');
        const content = buildGPX(original, []);
        const filename = localFilename(original);
        const identity = await localSaveIdentity(localId);
        const account = await ensureConnection();
        const key = savedRouteKey(account, localId, identity);
        const hash = await contentHash(content);
        const previous = await readSavedRoute(key);
        const preference = readSaveFolder(account);
        const folder = preference
            ? await drive.validateSaveFolder(preference.id)
            : await drive.ensureGPXFolder();
        saveFolderName = folder.name;
        let remote: DriveGPXFile | undefined;
        if (previous) {
            try {
                remote = await drive.getMetadata(previous.remote.id);
            } catch (e) {
                if (!(e instanceof Error && e.message.includes('GDrive error (404)'))) throw e;
            }
        }
        let saved: DriveGPXFile;
        if (
            previous &&
            remote &&
            drive.isManagedRoute(remote) &&
            remote.parents?.includes(folder.id) &&
            drive.canEdit(remote)
        ) {
            if (
                !previous.remote.modifiedTime ||
                previous.remote.modifiedTime !== remote.modifiedTime
            )
                throw new Error(
                    'Conflict: the saved copy changed in GDrive. Reopen it to review changes, or save a separate local copy.'
                );
            if (previous.hash === hash && remote.name === filename) {
                status = 'No changes to save';
                return remote;
            }
            saved = await drive.update(previous.remote, content, filename);
        } else {
            // Always create an app-owned copy. Never modify the file imported from Drive.
            saved = await drive.upload(
                new File([content], filename, { type: 'application/gpx+xml' }),
                folder.id
            );
        }
        remember(saved);
        const record: SavedRoute = {
            key,
            account,
            localId,
            identity,
            folderId: folder.id,
            remote: $state.snapshot(saved),
            hash,
        };
        const persisted = await writeSavedRoute(record);
        status = `Saved ${filename} to ${folder.name}`;
        if (!persisted)
            status += ' (save link lasts for this session; browser storage is unavailable)';
        return saved;
    }
    async function selectSaveFolder(folder: DriveGPXFile) {
        const account = await ensureConnection();
        const persisted = writeSaveFolder(account, folder);
        saveFolderName = folder.name;
        connected = drive.connected;
        toast.success(`Save folder: ${folder.name}${persisted ? '' : ' (this session only)'}`);
    }
    $effect(() => {
        if ($driveFolderOpen && !busy && !folderReady) {
            untrack(() => {
                void action(async () => {
                    try {
                        const account = await ensureConnection();
                        saveFolderName = readSaveFolder(account)?.name || 'GPX Files';
                        folderReady = true;
                    } catch (error) {
                        driveFolderOpen.set(false);
                        throw error;
                    }
                });
            });
        } else if (!$driveFolderOpen) folderReady = false;
    });
    function saveAll() {
        return action(async () => {
            const copies = new Map<string, string>();
            fileStateCollection.forEach((id, file) => copies.set(id, buildGPX(file, [])));
            if (!copies.size) return;
            const identities = new Map<string, string>();
            for (const [id, content] of copies) {
                const current = fileStateCollection.getFile(id);
                if (!current || buildGPX(current, []) !== content)
                    throw new Error(
                        'A local file changed. All working copies remain open; save again when ready.'
                    );
                identities.set(id, await localSaveIdentity(id));
                await saveLocalToDrive(id);
            }
            for (const [id, content] of copies) {
                const current = fileStateCollection.getFile(id);
                if (
                    !current ||
                    buildGPX(current, []) !== content ||
                    (await localSaveIdentity(id)) !== identities.get(id)
                )
                    throw new Error(
                        'A local file changed while saving. All working copies remain open.'
                    );
            }
            status = `Saved ${copies.size} local ${copies.size === 1 ? 'file' : 'files'} to GDrive`;
            toast.success(status);
        });
    }
    function save(localId: string) {
        return action(async () => {
            await saveLocalToDrive(localId);
            if (!$driveBrowserOpen) toast.success(status);
        });
    }
    function offerShare(localId: string) {
        const local = fileStateCollection.getFile(localId);
        if (!local) return;
        shareLocalId = localId;
        shareFile = { id: localId, name: localFilename(local) };
        shareOpen = true;
    }
    async function share(file: DriveGPXFile): Promise<string> {
        if (busy) throw new Error('Wait for the current operation to finish.');
        const view = captureSharedView();
        publicViewerURL(file, view);
        busy = true;
        error = '';
        status = '';
        let enabled = false;
        try {
            const saved = await saveLocalToDrive(shareLocalId);
            const shared = await drive.makePublic(saved);
            enabled = true;
            remember(shared);
            const identity = await localSaveIdentity(shareLocalId);
            const account = indexKey.slice(0, indexKey.lastIndexOf(':'));
            const key = savedRouteKey(account, shareLocalId, identity);
            const previous = await readSavedRoute(key);
            if (previous) await writeSavedRoute({ ...previous, remote: $state.snapshot(shared) });
            await downloadPublicGPX(publicDriveURL(shared.id, shared.resourceKey));
            status = `Public link ready for ${shared.name}`;
            return publicViewerURL(shared, view);
        } catch (e) {
            if (enabled)
                throw new Error(
                    'GDrive link sharing is enabled, but public viewing could not be verified. Check the public API key and website restrictions, then try again.'
                );
            throw e;
        } finally {
            connected = drive.connected;
            if (!connected) driveAccount.set(null);
            allDrive = drive.searchesAllDrive;
            busy = false;
        }
    }

    function disconnect() {
        return action(async () => {
            try {
                await drive.disconnect();
            } finally {
                ++indexEpoch;
                syncing = false;
                activeIndex = undefined;
                indexKey = '';
                indexedAt = 0;
                cacheMessage = '';
                localUpdates.clear();
                await clearDriveIndexes();
                connected = false;
                files = [];
                links = {};
                listed = false;
                status = '';
            }
        });
    }
</script>

<Dialog.Root bind:open={$driveBrowserOpen}>
    <Dialog.Content class="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <Dialog.Header>
            <Dialog.Title>Open from GDrive</Dialog.Title>
            <Dialog.Description
                >Find a GPX route in GDrive. Select a file to open it; choose Done when you’re ready
                to edit.</Dialog.Description
            >
        </Dialog.Header>
        <section class="min-w-0 text-sm" aria-label="GDrive files">
            <div class="flex items-center justify-between gap-2 mb-3">
                <div class="flex items-center gap-2 font-medium min-w-0">
                    <Cloud class="size-4 shrink-0" /><span>GDrive</span>
                    {#if connected}<span class="text-muted-foreground font-normal"
                            >({files.length})</span
                        >{/if}
                </div>
                <div class="flex items-center gap-2">
                    {#if connected}
                        <button
                            class="inline-flex size-8 items-center justify-center hover:bg-secondary rounded-md"
                            aria-label="Refresh GDrive"
                            title="Refresh GDrive"
                            onclick={refresh}
                            disabled={busy || syncing}><RefreshCw class="size-4" /></button
                        >
                    {/if}
                </div>
            </div>
            {#if !connected}
                <div class="mt-3 rounded-lg border bg-muted/30 p-3 min-w-0">
                    <p class="text-xs text-muted-foreground mb-3 leading-relaxed">
                        Sign in to open, save, and share your routes in GDrive.
                    </p>
                    <Button
                        class="w-full h-auto min-h-9 px-2 gap-2 whitespace-normal text-xs"
                        onclick={connect}
                        disabled={busy}
                    >
                        <LogIn class="size-4 shrink-0" />
                        <span>{busy ? 'Signing in…' : 'Sign in with Google'}</span>
                    </Button>
                    <p class="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                        Connects Drive in one step. Local files work without signing in.
                    </p>
                </div>
            {:else}
                <p class="mt-2 text-xs text-muted-foreground">
                    {allDrive
                        ? 'GPX files across My Drive and shared drives.'
                        : 'Files created or previously opened with this app.'}
                </p>
                {#if !allDrive}
                    <Button
                        variant="outline"
                        class="mt-2 w-full text-xs gap-1.5"
                        disabled={busy}
                        onclick={searchAllDrive}
                    >
                        <Search class="size-3.5" />Search all GDrive
                    </Button>
                    <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        Requires Google read access to all GDrive files. Only GPX routes are listed.
                    </p>
                {:else}
                    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Files open as local working copies.
                    </p>
                {/if}
                {#if cacheMessage}<p
                        class="mt-2 text-xs text-muted-foreground"
                        aria-live="polite"
                        data-testid="drive-index-status"
                    >
                        {cacheMessage}
                    </p>{/if}
                <input
                    class="mt-2 w-full rounded border bg-background px-2 py-1"
                    aria-label="Search GDrive files"
                    placeholder="Search GDrive files..."
                    bind:value={query}
                />
                <div class="mt-2 max-h-[45dvh] overflow-y-auto divide-y divide-border">
                    {#each filtered as file (file.id)}
                        <div
                            class="group flex items-center gap-0.5 rounded-md hover:bg-secondary px-1 py-0.5 min-w-0"
                            class:bg-secondary={!!links[file.id]}
                        >
                            <button
                                class="flex items-center gap-1.5 min-w-0 flex-1 text-left py-1.5 font-medium"
                                title={file.name}
                                onclick={() => open(file)}
                                disabled={busy}
                            >
                                {#if links[file.id]}<Check
                                        class="size-3.5 shrink-0 text-muted-foreground"
                                    />{:else}<ChevronRight
                                        class="size-3.5 shrink-0 text-muted-foreground"
                                    />{/if}
                                <FileText class="size-3.5 shrink-0 text-muted-foreground" />
                                <span class="truncate">{file.name}</span>
                            </button>
                        </div>
                    {/each}
                    {#if !filtered.length}
                        <p class="text-muted-foreground text-xs mt-1">
                            {busy
                                ? 'Searching GDrive…'
                                : files.length
                                  ? 'No matching files'
                                  : 'No GPX files found in GDrive.'}
                        </p>
                    {/if}
                </div>
            {/if}
            {#if busy}<p class="mt-1 text-xs">Working…</p>{/if}
            {#if error}<p class="mt-1 text-xs text-red-600 break-words" role="alert">
                    {error}
                </p>{/if}
            {#if status}<p class="mt-1 text-xs text-green-700 break-words" role="status">
                    {status}
                </p>{/if}
        </section>
        <Dialog.Footer
            ><Button onclick={() => driveBrowserOpen.set(false)}>Done</Button></Dialog.Footer
        >
    </Dialog.Content>
</Dialog.Root>

{#if shareFile && shareOpen}
    <DriveShareDialog file={shareFile} onshare={share} bind:open={shareOpen} />
{/if}

{#if $driveFolderOpen && folderReady}
    <DriveFolderDialog
        {drive}
        currentName={saveFolderName}
        onselect={selectSaveFolder}
        bind:open={$driveFolderOpen}
    />
{/if}
