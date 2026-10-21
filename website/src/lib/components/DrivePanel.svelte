<script lang="ts">
    import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';
    import { DriveClient, type DriveGPXFile } from '$lib/drive/client';
    import { loadFiles } from '$lib/logic/file-actions';

    const drive = new DriveClient(PUBLIC_GOOGLE_CLIENT_ID);
    let connected = $state(false);
    let busy = $state(false);
    let error = $state('');
    let status = $state('');
    let files = $state<DriveGPXFile[]>([]);
    let expanded = $state(false);
    let uploadInput = $state<HTMLInputElement>();

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
        action(async () => { await loadFiles([await drive.download(file)]); status = `Opened ${file.name}`; });
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

<div class="absolute top-14 left-3 z-40 rounded-md border bg-background p-2 shadow-md max-w-[320px] text-sm">
    <div class="flex items-center gap-2">
        {#if !connected}
            <button class="border rounded px-2 py-1 hover:bg-secondary" onclick={connect} disabled={busy}>Connect Google Drive</button>
        {:else}
            <button class="border rounded px-2 py-1 hover:bg-secondary" onclick={() => expanded = !expanded}>Drive ({files.length})</button>
            <button class="border rounded px-2 py-1 hover:bg-secondary" onclick={refresh} disabled={busy}>Refresh</button>
            <button class="border rounded px-2 py-1 hover:bg-secondary" onclick={() => { drive.disconnect(); connected = false; files = []; }}>Disconnect</button>
        {/if}
    </div>
    {#if connected && expanded}
        <div class="mt-2 flex gap-2">
            <button class="border rounded px-2 py-1 hover:bg-secondary" onclick={() => uploadInput.click()} disabled={busy}>Upload GPX</button>
            <input class="hidden" type="file" accept=".gpx,application/gpx+xml" bind:this={uploadInput} onchange={upload}/>
        </div>
        <div class="mt-2 max-h-52 overflow-y-auto">
            {#each files as file (file.id)}
                <button class="block w-full text-left py-1 border-b hover:bg-secondary truncate" onclick={() => open(file)} disabled={busy} title={file.name}>{file.name}</button>
            {/each}
            {#if !files.length}<p class="text-muted-foreground">No GPX files accessible yet. Upload one to start.</p>{/if}
        </div>
    {/if}
    {#if busy}<p class="mt-1">Working…</p>{/if}
    {#if error}<p class="mt-1 text-red-600" role="alert">{error}</p>{/if}
    {#if status}<p class="mt-1 text-green-700">{status}</p>{/if}
</div>
