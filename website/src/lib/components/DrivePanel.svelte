<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import {
        driveBrowserOpen,
        cloudFiles,
        cloudSaveStatus,
        cloudCloseGuard,
        driveLocalActions,
        driveAccount,
        driveBatchActions,
    } from '$lib/drive/browser';
    import { toast } from 'svelte-sonner';
    import { createRoutePreview } from '$lib/drive/route-preview';
    import { captureSharedView } from '$lib/drive/sharing';
    import { Button } from '$lib/components/ui/button';
    import { Cloud, LogIn, FileText, ChevronRight, Check, RefreshCw, Search } from '@lucide/svelte';
    import DriveFolderDialog from '$lib/components/DriveFolderDialog.svelte';
    import { readSaveFolder, writeSaveFolder } from '$lib/drive/save-folder';
    import DriveShareDialog from '$lib/components/DriveShareDialog.svelte';
    import { publicDriveURL, publicViewerURL, downloadPublicGPX } from '$lib/drive/public';
    import { onMount, onDestroy, untrack } from 'svelte';
    import { dragging } from '$lib/components/file-list/sortable-file-list';
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
        cloudCloseGuard.set(confirmClose);
        void action(async () => {
            if (await drive.restore()) {
                connected = true;
                status = 'GDrive connected';
                driveAccount.set({});
                // Profile details are optional; browsing still verifies the account separately.
                await ensureConnection().catch(() => {});
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
    let saveFolder = $state<Pick<DriveGPXFile, 'id' | 'name'>>();
    let saveFilename = $state('Route.gpx');
    let folderOpen = $state(false);
    let activeAccount = $state('');
    let savedRoutes = $state<Record<string, SavedRoute>>({});
    let folderChoice: ((folder?: DriveGPXFile) => void) | undefined;
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
    let chosenFile = $state<DriveGPXFile | null>(null);
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
                saveAs: () => {
                    void save(localId, true);
                },
                ...(connected &&
                savedRoutes[localId]?.account === activeAccount &&
                fileStateCollection.getFile(localId)?._data.driveIdentity ===
                    savedRoutes[localId]?.identity
                    ? {
                          share: () => offerShare(localId),
                          remoteName: savedRoutes[localId].remote.name,
                      }
                    : {}),
            };
        }
        driveLocalActions.set(actions);
        driveBatchActions.set({
            busy,
            saveAll: (ids) => {
                void saveAll(ids);
            },
            connect: () => {
                void action(async () => {
                    await ensureConnection();
                });
            },
            disconnect: () => {
                void disconnect();
            },
        });
    });
    // Observe working copies even while disconnected; their cloud source is durable.
    $effect(() => {
        const states = [...$fileStateCollection.entries()];
        const account = activeAccount;
        untrack(() =>
            cloudFiles.update((files) =>
                Object.fromEntries(
                    Object.entries(files).filter(([id]) => states.some(([fileId]) => fileId === id))
                )
            )
        );
        const subscriptions = untrack(() =>
            states.map(([id, state]) => {
                let revision = 0;
                const unsubscribe = state.subscribe((value) => {
                    const version = ++revision;
                    const file = value?.file;
                    if (!file) return;
                    const serialized = buildGPX(file, []);
                    if (pendingContent.get(id) !== serialized) {
                        pendingContent.set(id, serialized);
                        autosaveRevision++;
                    }
                    const identity = file._data.driveIdentity as string | undefined;
                    const embedded = file._data.cloudLink as SavedRoute | undefined;
                    const record =
                        embedded && embedded.identity === identity
                            ? (JSON.parse(JSON.stringify(embedded)) as SavedRoute)
                            : undefined;
                    if (record) {
                        if (record.account === account) {
                            savedRoutes[id] = record;
                            links[record.remote.id] = { localId: id, identity: record.identity };
                        }
                        cloudFiles.update((files) => ({
                            ...files,
                            [id]: {
                                provider: 'gdrive',
                                account: record.account,
                                remoteName: record.remote.name,
                                dirty: files[id]?.dirty ?? false,
                            },
                        }));
                        void contentHash(buildGPX(file, [])).then((hash) => {
                            if (version === revision)
                                cloudFiles.update((files) => ({
                                    ...files,
                                    [id]: {
                                        provider: 'gdrive',
                                        account: record.account,
                                        remoteName: record.remote.name,
                                        dirty: hash !== record.hash,
                                    },
                                }));
                        });
                    } else {
                        cloudFiles.update((files) => {
                            const next = { ...files };
                            delete next[id];
                            return next;
                        });
                        if (account && identity)
                            void readSavedRoute(savedRouteKey(account, id, identity)).then(
                                async (saved) => {
                                    if (
                                        saved &&
                                        version === revision &&
                                        activeAccount === account
                                    ) {
                                        savedRoutes[id] = saved;
                                        await writeSavedRoute(saved);
                                    }
                                }
                            );
                    }
                });
                return () => {
                    ++revision;
                    unsubscribe();
                };
            })
        );
        return () => subscriptions.forEach((unsubscribe) => unsubscribe());
    });
    $effect(() => {
        if (!folderOpen && folderChoice) {
            folderChoice();
            folderChoice = undefined;
        }
    });
    let closeIds = $state<string[] | null>(null);
    let closeError = $state('');
    let closeChoice: ((accepted: boolean) => void) | undefined;
    const pendingContent = new Map<string, string>();
    $effect(() => {
        const entries = Object.entries($cloudFiles);
        const ready = connected && !busy && !closeIds && $dragging === null;
        const account = activeAccount;
        // Status is deliberately untracked: failures stop autosave until explicit retry.
        const states = untrack(() => $cloudSaveStatus);
        const candidates = entries.filter(([id, source]) => {
            const record = savedRoutes[id];
            return (
                source.dirty &&
                source.account === account &&
                record &&
                drive.isManagedRoute(record.remote) &&
                drive.canEdit(record.remote) &&
                states[id]?.state !== 'error'
            );
        });
        // Reading the individual stores in the observer below updates this map on every edit.
        void autosaveRevision;
        if (!ready || !candidates.length) return;
        const timer = setTimeout(() => void autosave(candidates[0][0]), 2000);
        return () => clearTimeout(timer);
    });
    let autosaveRevision = $state(0);
    async function autosave(id: string) {
        if (busy || !connected || closeIds || $dragging !== null || !$cloudFiles[id]?.dirty) return;
        busy = true;
        cloudSaveStatus.update((states) => ({ ...states, [id]: { state: 'saving' } }));
        try {
            await saveLocalToDrive(id, false, undefined, true);
            cloudSaveStatus.update((states) => ({ ...states, [id]: { state: 'saved' } }));
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            cloudSaveStatus.update((states) => ({ ...states, [id]: { state: 'error', message } }));
            toast.error('Could not autosave to GDrive. Your edits remain in this browser.', {
                description: message,
                action: {
                    label: 'Retry',
                    onClick: () => {
                        void save(id);
                    },
                },
            });
        } finally {
            busy = false;
        }
    }
    async function confirmClose(ids: string[]): Promise<boolean> {
        const dirty: string[] = [];
        for (const id of ids) {
            const file = fileStateCollection.getFile(id);
            const record = file?._data.cloudLink as SavedRoute | undefined;
            if (file && record && (await contentHash(buildGPX(file, []))) !== record.hash)
                dirty.push(id);
        }
        if (!dirty.length) return true;
        if (busy || closeChoice) {
            toast.info('A cloud operation is in progress. Try closing again when it finishes.');
            return false;
        }
        closeIds = dirty;
        closeError = '';
        return new Promise((resolve) => {
            closeChoice = resolve;
        });
    }
    function finishClose(accepted: boolean) {
        closeChoice?.(accepted);
        closeChoice = undefined;
        closeIds = null;
    }
    async function saveAndClose() {
        if (busy || !closeIds) return;
        busy = true;
        closeError = '';
        try {
            for (const id of closeIds) {
                if (!$cloudFiles[id] || !connected || $cloudFiles[id].account !== activeAccount)
                    throw new Error('Connect the account that owns this file before saving.');
                const saved = await saveLocalToDrive(id, false, undefined, true);
                const file = fileStateCollection.getFile(id);
                const record = file?._data.cloudLink as SavedRoute | undefined;
                if (
                    !saved ||
                    !file ||
                    !record ||
                    (await contentHash(buildGPX(file, []))) !== record.hash
                )
                    throw new Error(
                        'The file changed while saving. Save again to include your latest edits.'
                    );
            }
            for (const id of closeIds) {
                const file = fileStateCollection.getFile(id);
                const record = file?._data.cloudLink as SavedRoute | undefined;
                if (!file || !record || (await contentHash(buildGPX(file, []))) !== record.hash)
                    throw new Error(
                        'A file changed while saving. Save again to include your latest edits.'
                    );
            }
            finishClose(true);
        } catch (e) {
            closeError = `${e instanceof Error ? e.message : String(e)} Your files remain open.`;
        } finally {
            busy = false;
        }
    }
    $effect(() => {
        const warn = (event: BeforeUnloadEvent) => {
            if (Object.values($cloudFiles).some((file) => file.dirty)) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    });
    function chooseSaveFolder(filename = 'Route.gpx'): Promise<DriveGPXFile | undefined> {
        saveFolder = readSaveFolder(activeAccount);
        saveFilename = filename;
        folderOpen = true;
        return new Promise((resolve) => {
            folderChoice = resolve;
        });
    }
    onDestroy(() => {
        ++indexEpoch;
        cloudCloseGuard.set(async () => true);
        closeChoice?.(false);
        folderChoice?.();
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
            {
                const account = await ensureConnection();
                const record: SavedRoute = {
                    key: savedRouteKey(account, ids[0], identity),
                    account,
                    localId: ids[0],
                    identity,
                    remote,
                    folderId: remote.parents?.[0] || 'root',
                    hash: await contentHash(snapshot),
                    localName: localFilename(imported),
                };
                await writeSavedRoute(record);
                savedRoutes[ids[0]] = record;
            }
            selection.selectFileWhenLoaded(ids[0]);
            boundsManager.fitBoundsOnLoad(ids);
            status = `Opened ${file.name}`;
        });
    }
    async function openChosen(file: DriveGPXFile) {
        await open(file);
        if (!error) {
            driveBrowserOpen.set(false);
            chosenFile = null;
        }
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
        activeAccount = account;
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
    async function saveLocalToDrive(
        localId: string,
        forceCopy = false,
        batchFolder?: DriveGPXFile,
        automatic = false
    ): Promise<DriveGPXFile | undefined> {
        const original = fileStateCollection.getFile(localId);
        if (!original) throw new Error('Local working copy not available');
        const content = buildGPX(original, []);
        const localName = localFilename(original);
        let filename = localName;
        const identity = await localSaveIdentity(localId);
        const account = await ensureConnection();
        const key = savedRouteKey(account, localId, identity);
        const hash = await contentHash(content);
        const previous = await readSavedRoute(key);
        let remote: DriveGPXFile | undefined;
        if (previous) {
            try {
                remote = await drive.getMetadata(previous.remote.id);
            } catch (e) {
                if (!(e instanceof Error && e.message.includes('GDrive error (404)'))) throw e;
            }
        }
        const updateExisting =
            !forceCopy &&
            previous &&
            remote &&
            drive.isManagedRoute(remote) &&
            drive.canEdit(remote);
        if (automatic && !updateExisting)
            throw new Error(
                'This cloud file cannot be updated. Use Save as to choose a writable destination.'
            );
        const folder = updateExisting
            ? { id: previous.folderId, name: 'GDrive' }
            : batchFolder || (await chooseSaveFolder(filename));
        if (!folder) return;
        if (updateExisting && previous?.localName === localName && remote) filename = remote.name;
        if (!updateExisting && !batchFolder) filename = saveFilename;
        // The route may have been edited or closed while choosing a destination.
        const current = fileStateCollection.getFile(localId);
        if (
            !current ||
            current._data.driveIdentity !== identity ||
            buildGPX(current, []) !== content
        )
            throw new Error(
                'The route changed while choosing a folder. Save again to include your latest edits.'
            );
        let saved: DriveGPXFile;
        if (updateExisting && previous && remote) {
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
            localName,
        };
        const persisted = await writeSavedRoute(record);
        savedRoutes[localId] = record;
        cloudSaveStatus.update((states) => ({ ...states, [localId]: { state: 'saved' } }));
        for (const [remoteId, link] of Object.entries(links))
            if (link.localId === localId) delete links[remoteId];
        links[saved.id] = { localId, identity };
        status = `Saved ${filename} to ${folder.name}`;
        if (!persisted)
            status += ' (save link lasts for this session; browser storage is unavailable)';
        return saved;
    }
    async function selectSaveFolder(folder: DriveGPXFile) {
        writeSaveFolder(activeAccount, folder);
        folderChoice?.(folder);
        folderChoice = undefined;
    }
    function saveAll(ids: string[]) {
        return action(async () => {
            const snapshots = new Map<string, { content: string; identity: string }>();
            for (const id of new Set(ids)) {
                const file = fileStateCollection.getFile(id);
                if (!file) throw new Error('A file was closed. Try again.');
                snapshots.set(id, {
                    content: buildGPX(file, []),
                    identity: await localSaveIdentity(id),
                });
            }
            if (!snapshots.size) return;
            for (const [id, snapshot] of snapshots) {
                const file = fileStateCollection.getFile(id);
                if (!file || buildGPX(file, []) !== snapshot.content)
                    throw new Error('A file changed. Files remain open; save again.');
                if (!(await saveLocalToDrive(id))) {
                    toast.info('Save cancelled. Files remain open.');
                    return;
                }
            }
            for (const [id, snapshot] of snapshots) {
                const file = fileStateCollection.getFile(id);
                if (
                    !file ||
                    buildGPX(file, []) !== snapshot.content ||
                    (await localSaveIdentity(id)) !== snapshot.identity
                )
                    throw new Error('A file changed while saving. Files remain open.');
            }
            toast.success(`Saved ${snapshots.size} ${snapshots.size === 1 ? 'file' : 'files'}`);
        });
    }
    function save(localId: string, forceCopy = false) {
        return action(async () => {
            cloudSaveStatus.update((states) => ({ ...states, [localId]: { state: 'saving' } }));
            const wasLocal = !$cloudFiles[localId];
            let saved: DriveGPXFile | undefined;
            try {
                saved = await saveLocalToDrive(localId, forceCopy);
            } catch (e) {
                const reason = e instanceof Error ? e.message : String(e);
                cloudSaveStatus.update((states) => ({
                    ...states,
                    [localId]: { state: 'error', message: reason },
                }));
                throw new Error(
                    `Could not complete the save to GDrive. ${wasLocal ? 'Your file remains in Local files, with your edits intact.' : 'Your edits remain in this browser.'} Try saving again. ${reason}`
                );
            }
            if (!saved) {
                toast.info(
                    wasLocal
                        ? 'Save cancelled. Your file remains in Local files.'
                        : 'Save cancelled. Your file remains open with your edits intact.'
                );
                return;
            }
            cloudSaveStatus.update((states) => ({ ...states, [localId]: { state: 'saved' } }));
            if (!$driveBrowserOpen) toast.success(status);
        });
    }
    function offerShare(localId: string) {
        const saved = savedRoutes[localId];
        if (
            !connected ||
            !saved ||
            saved.account !== activeAccount ||
            fileStateCollection.getFile(localId)?._data.driveIdentity !== saved.identity
        )
            return;
        shareLocalId = localId;
        shareFile = saved.remote;
        shareOpen = true;
    }
    async function saveBeforeShare() {
        let saved: DriveGPXFile | undefined;
        await action(async () => {
            saved = await saveLocalToDrive(shareLocalId);
        });
        if (!saved) throw new Error(error || 'Save cancelled. Your file has not been shared.');
        shareFile = saved;
    }
    async function share(file: DriveGPXFile): Promise<string> {
        if (busy) throw new Error('Wait for the current operation to finish.');
        const view = captureSharedView();
        publicViewerURL(file, view);
        busy = true;
        error = '';
        status = '';
        let enabled = false;
        let verified = false;
        try {
            const account = await ensureConnection();
            const record = savedRoutes[shareLocalId];
            if (
                !record ||
                record.account !== account ||
                fileStateCollection.getFile(shareLocalId)?._data.driveIdentity !== record.identity
            )
                throw new Error('Save this file to GDrive before sharing.');
            const current = fileStateCollection.getFile(shareLocalId);
            if (!current || (await contentHash(buildGPX(current, []))) !== record.hash)
                throw new Error('Save your changes to GDrive before sharing this route.');
            const remote = await drive.getMetadata(record.remote.id, record.remote.resourceKey);
            if (!drive.canShare(remote))
                throw new Error(
                    'This GDrive file cannot be shared by this app. Use Save a copy to GDrive, then share the saved copy.'
                );
            const shared = await drive.makePublic(remote);
            enabled = true;
            remember(shared);
            const identity = await localSaveIdentity(shareLocalId);
            const key = savedRouteKey(account, shareLocalId, identity);
            const previous = await readSavedRoute(key);
            if (previous) {
                const updated = { ...previous, remote: $state.snapshot(shared) };
                await writeSavedRoute(updated);
                savedRoutes[shareLocalId] = updated;
            }
            const publicGPX = await downloadPublicGPX(
                publicDriveURL(shared.id, shared.resourceKey)
            );
            verified = true;
            const preview = await createRoutePreview(publicGPX, shared.name, view);
            const link = await drive.createShortShare(
                shared,
                view,
                publicViewerURL(shared, view),
                preview
            );
            status = `Public link ready for ${shared.name}`;
            return link;
        } catch (e) {
            if (enabled && verified)
                throw new Error(
                    'Your saved route is public, but the short link could not be created. Try again.'
                );
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
                activeAccount = '';
                savedRoutes = {};
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
            <Dialog.Description>Choose a GPX file to open.</Dialog.Description>
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
                    <p class="mt-1 text-xs text-muted-foreground">
                        Google will ask permission to find existing GPX files.
                    </p>
                {:else}
                    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Files open as cloud files.
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
                            class:bg-secondary={chosenFile?.id === file.id}
                            aria-current={chosenFile?.id === file.id ? 'true' : undefined}
                        >
                            <button
                                class="flex items-center gap-1.5 min-w-0 flex-1 text-left py-1.5 font-medium"
                                title={file.name}
                                onclick={() => {
                                    chosenFile = file;
                                }}
                                ondblclick={() => {
                                    void openChosen(file);
                                }}
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
        <Dialog.Footer>
            <Button variant="outline" disabled={busy} onclick={() => driveBrowserOpen.set(false)}
                >Cancel</Button
            >
            <Button
                disabled={busy || !chosenFile}
                onclick={() => {
                    if (chosenFile) void openChosen(chosenFile);
                }}>{busy ? 'Opening…' : 'Open'}</Button
            >
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>

{#if shareFile && shareOpen}
    <DriveShareDialog
        file={shareFile}
        onshare={share}
        dirty={$cloudFiles[shareLocalId]?.dirty ?? false}
        onsave={saveBeforeShare}
        bind:open={shareOpen}
    />
{/if}

{#if folderOpen}
    <DriveFolderDialog
        {drive}
        currentFolder={saveFolder}
        bind:filename={saveFilename}
        onselect={selectSaveFolder}
        bind:open={folderOpen}
    />
{/if}

<Dialog.Root
    open={closeIds !== null}
    onOpenChange={(open) => {
        if (!open && !busy) finishClose(false);
    }}
>
    <Dialog.Content>
        <Dialog.Header>
            <Dialog.Title>Unsaved cloud changes</Dialog.Title>
            <Dialog.Description
                >Save your changes before closing? Discard leaves the cloud version unchanged.</Dialog.Description
            >
        </Dialog.Header>
        {#if closeError}<p role="alert" class="text-sm text-red-600">{closeError}</p>{/if}
        <Dialog.Footer>
            <Button variant="outline" disabled={busy} onclick={() => finishClose(false)}
                >Cancel</Button
            >
            <Button variant="outline" disabled={busy} onclick={() => finishClose(true)}
                >Discard changes</Button
            >
            <Button disabled={busy} onclick={saveAndClose}
                >{busy ? 'Saving…' : 'Save and close'}</Button
            >
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
