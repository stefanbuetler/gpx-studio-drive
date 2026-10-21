<script lang="ts">
    import { DriveClient, type DriveGPXFile } from '$lib/drive/client';
    import { loadFile, fileActions } from '$lib/logic/file-actions';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { selection } from '$lib/logic/selection';
    import { boundsManager } from '$lib/logic/bounds';
    import { buildGPX } from 'gpx';
    import { get } from 'svelte/store';

    const drive = new DriveClient('1029721603429-0h1hv3datbk3guc18kq8ta2od0gevqi4.apps.googleusercontent.com');
    let connected = $state(false);
    let busy = $state(false);
    let error = $state('');
    let status = $state('');
    let files = $state<DriveGPXFile[]>([]);
    let uploadInput = $state<HTMLInputElement>();
    let links = $state<Record<string, { localId: string; remote: DriveGPXFile; savedSnapshot: string }>>({});
    let query = $state('');
    let expanded = $state(true);
    let filtered = $derived(files.filter(f => f.name.toLowerCase().includes(query.toLowerCase())));

    async function action(operation: () => Promise<void>) {
        busy = true; error = ''; status = '';
        try { await operation(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
        finally { busy = false; }
    }
    function connect() {
        action(async () => {
            await drive.connect(); connected = true;
            files = await drive.listGPX(); expanded = true;
            status = 'Google Drive connected';
        });
    }
    function refresh() { action(async () => { files = await drive.listGPX(); }); }
    function open(file: DriveGPXFile) {
        action(async () => {
            const existing = links[file.id];
            if (existing && fileStateCollection.getFile(existing.localId)) {
                selection.selectFileWhenLoaded(existing.localId);
                status = `Already open: ${file.name}`;
                return;
            }
            const imported = await loadFile(await drive.download(file));
            if (!imported) throw new Error('Could not read GPX file');
            const ids = fileActions.addMultiple([imported]);
            links[file.id] = { localId: ids[0], remote: file, savedSnapshot: buildGPX(imported, []) };
            selection.selectFileWhenLoaded(ids[0]);
            boundsManager.fitBoundsOnLoad(ids);
            status = `Opened ${file.name}`;
        });
    }
    function save(file: DriveGPXFile) {
        action(async () => {
            const link = links[file.id];
            if (!link) throw new Error('Open this route in the editor first');
            const edited = fileStateCollection.getFile(link.localId);
            if (!edited) throw new Error('Local working copy not available');
            const content = buildGPX(edited, []);
            if (content === link.savedSnapshot) {
                status = 'No changes to save';
                return;
            }
            const updated = await drive.update(link.remote, content);
            links[file.id] = { ...link, remote: updated, savedSnapshot: content };
            files = files.map(f => f.id === file.id ? updated : f);
            status = `Saved ${file.name} to Google Drive`;
        });
    }
    function upload(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        action(async () => {
            await drive.upload(file);
            files = await drive.listGPX();
            status = `Uploaded ${file.name}`;
            input.value = '';
        });
    }
</script>

    function disconnect() {
        drive.disconnect(); connected = false; files = []; links = {}; error = ''; status = '';
    }
</script>

<section class="border-t mt-2 py-2 px-2 text-sm" aria-label="Google Drive files">
    <div class="flex items-center justify-between gap-1">
        <button class="flex items-center gap-1 min-w-0 font-semibold" onclick={() => expanded = !expanded}>
            <span>{expanded ? '▾' : '▸'}</span><span>☁ Google Drive</span>
            {#if connected}<span class="text-muted-foreground font-normal">({files.length})</span>{/if}
        </button>
        {#if connected}
            <button class="px-1 hover:bg-secondary rounded" title="Refresh Drive" onclick={refresh} disabled={busy}>↻</button>
            <button class="px-1 hover:bg-secondary rounded" title="Upload GPX" onclick={() => uploadInput?.click()} disabled={busy}>＋</button>
            <button class="px-1 hover:bg-secondary rounded" title="Disconnect" onclick={disconnect}>⏻</button>
        {/if}
    </div>
    <input class="hidden" type="file" accept=".gpx,application/gpx+xml" bind:this={uploadInput} onchange={upload}/>
    {#if expanded}
        {#if !connected}
            <button class="mt-2 border rounded px-2 py-1 hover:bg-secondary" onclick={connect} disabled={busy}>Connect Google Drive</button>
        {:else}
            <input class="mt-2 w-full rounded border bg-background px-2 py-1" placeholder="Search Drive files..." bind:value={query}/>
            <div class="mt-2 max-h-64 overflow-y-auto">
                {#each filtered as file (file.id)}
                    <div class="flex items-center gap-1 rounded hover:bg-secondary px-1 py-1">
                        <button class="min-w-0 flex-1 text-left truncate" title={file.name} onclick={() => open(file)} disabled={busy}>
                            <span>{links[file.id] ? '☑' : '▹'}</span> {file.name}
                        </button>
                        {#if links[file.id]}
                            <button class="shrink-0 border rounded px-1" onclick={() => save(file)} disabled={busy} title="Save edits to Google Drive">Save</button>
                        {/if}
                    </div>
                {/each}
                {#if !filtered.length}
                    <p class="text-muted-foreground text-xs mt-1">{files.length ? 'No matching files' : 'No accessible GPX files yet. Upload one to start.'}</p>
                {/if}
            </div>
        {/if}
    {/if}
    {#if busy}<p class="mt-1 text-xs">Working…</p>{/if}
    {#if error}<p class="mt-1 text-xs text-red-600 break-words" role="alert">{error}</p>{/if}
    {#if status}<p class="mt-1 text-xs text-green-700 break-words">{status}</p>{/if}
</section>
