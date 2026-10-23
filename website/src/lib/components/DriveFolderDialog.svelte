<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import { Button } from '$lib/components/ui/button';
    import { Folder, ChevronRight, ArrowLeft, Plus } from '@lucide/svelte';
    import type { DriveClient, DriveGPXFile } from '$lib/drive/client';
    import { untrack } from 'svelte';
    let {
        drive,
        currentFolder,
        filename = $bindable('Route.gpx'),
        onselect,
        open = $bindable(false),
    }: {
        drive: DriveClient;
        currentFolder?: Pick<DriveGPXFile, 'id' | 'name'>;
        filename?: string;
        onselect: (folder: DriveGPXFile) => Promise<void>;
        open?: boolean;
    } = $props();
    let path = $state(
        untrack(() =>
            currentFolder && currentFolder.id !== 'root'
                ? [{ id: 'root', name: 'My Drive' }, currentFolder]
                : [{ id: 'root', name: 'My Drive' }]
        )
    );
    let browsing = $state(false);
    let creating = $state(false);
    let folders = $state<DriveGPXFile[]>([]);
    let nextPage = $state<string>();
    let name = $state('');
    let filter = $state('');
    let busy = $state(false);
    let error = $state('');
    const current = $derived(path[path.length - 1]);
    const filtered = $derived(
        folders.filter((folder) =>
            folder.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
        )
    );
    async function run(operation: () => Promise<void>) {
        if (busy) return;
        busy = true;
        error = '';
        try {
            await operation();
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            error = /GDrive error \((403|404)\)/.test(reason)
                ? 'This folder is unavailable or GDrive has not granted access to it. Choose another folder or browse all GDrive folders. Your file remains open with your edits intact.'
                : `${reason} Your file remains open with your edits intact.`;
        } finally {
            busy = false;
        }
    }
    async function list(more = false) {
        const result = await drive.listFolders(current.id, more ? nextPage : undefined);
        folders = more ? [...folders, ...result.files] : result.files;
        nextPage = result.nextPageToken;
    }
    function browse() {
        browsing = !browsing;
        if (browsing) void run(list);
    }
    function enter(folder: { id: string; name: string }) {
        return run(async () => {
            path = [...path, folder];
            filter = '';
            folders = [];
            await list();
        });
    }
    function back() {
        return run(async () => {
            path = path.slice(0, -1);
            filter = '';
            folders = [];
            await list();
        });
    }
    function choose() {
        return run(async () => {
            filename = filename.trim();
            if (!filename || /[\\/]/.test(filename))
                throw new Error('Enter a filename without slashes.');
            if (!filename.toLowerCase().endsWith('.gpx')) filename += '.gpx';
            await onselect(await drive.validateSaveFolder(current.id));
            open = false;
        });
    }
    function create() {
        return run(async () => {
            const folder = await drive.createFolder(name, current.id);
            name = '';
            path = [...path, folder];
            folders = [];
            nextPage = undefined;
        });
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <Dialog.Header>
            <Dialog.Title>Save to GDrive</Dialog.Title>
            <Dialog.Description>Choose a filename and destination.</Dialog.Description>
        </Dialog.Header>
        <label class="text-sm font-medium" for="drive-save-name">Filename</label>
        <input
            id="drive-save-name"
            class="w-full rounded border bg-background px-3 py-2 text-sm"
            bind:value={filename}
            maxlength="200"
            disabled={busy}
        />
        <div class="space-y-2">
            <span class="text-sm font-medium">Folder</span>
            <div class="flex items-center gap-2 rounded border px-3 py-2">
                <Folder class="size-4 shrink-0" />
                <span
                    class="min-w-0 flex-1 truncate text-sm"
                    title={path.map((folder) => folder.name).join(' / ')}
                    >{path.map((folder) => folder.name).join(' / ')}</span
                >
                <Button variant="ghost" size="sm" disabled={busy} onclick={browse}
                    >{browsing ? 'Done' : 'Change…'}</Button
                >
            </div>
        </div>
        {#if browsing}
            <div class="space-y-2 rounded border bg-muted/20 p-3">
                <div class="flex items-center justify-between gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Parent folder"
                        disabled={busy || path.length === 1}
                        onclick={back}><ArrowLeft class="size-4" />Parent folder</Button
                    >
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onclick={() => {
                            creating = !creating;
                        }}>New folder</Button
                    >
                </div>
                {#if !drive.searchesAllDrive}
                    <Button
                        variant="outline"
                        class="w-full"
                        disabled={busy}
                        onclick={() =>
                            run(async () => {
                                await drive.connect(true);
                                await list();
                            })}>Browse all GDrive folders</Button
                    >
                    <p class="text-xs text-muted-foreground">
                        Google will ask permission to browse existing folders.
                    </p>
                {/if}
                <input
                    class="w-full rounded border bg-background px-3 py-2 text-sm"
                    aria-label="Filter folders"
                    placeholder="Find a folder…"
                    bind:value={filter}
                />
                <div
                    class="max-h-48 overflow-y-auto divide-y rounded border"
                    aria-label="GDrive folders"
                >
                    {#each filtered as folder (folder.id)}
                        <button
                            class="flex w-full items-center gap-2 p-2 text-left text-sm hover:bg-secondary disabled:opacity-50"
                            disabled={busy}
                            onclick={() => enter(folder)}
                            ><Folder class="size-4 shrink-0" /><span class="truncate flex-1"
                                >{folder.name}</span
                            ><ChevronRight class="size-4 shrink-0" /></button
                        >
                    {/each}
                    {#if !filtered.length}<p class="p-3 text-sm text-muted-foreground">
                            {busy ? 'Loading folders…' : 'No folders found here.'}
                        </p>{/if}
                    {#if nextPage}<Button
                            variant="ghost"
                            class="w-full"
                            disabled={busy}
                            onclick={() => run(() => list(true))}>Load more folders</Button
                        >{/if}
                </div>
                {#if creating}
                    <form
                        class="flex gap-2"
                        onsubmit={(event) => {
                            event.preventDefault();
                            void create();
                        }}
                    >
                        <input
                            class="min-w-0 flex-1 rounded border bg-background px-3 py-2 text-sm"
                            aria-label="New folder name"
                            placeholder="Folder name"
                            maxlength="200"
                            bind:value={name}
                            disabled={busy}
                        />
                        <Button type="submit" variant="outline" disabled={busy || !name.trim()}
                            ><Plus class="size-4" />Create folder</Button
                        >
                    </form>
                {/if}
            </div>
        {/if}
        {#if error}<p class="text-sm text-red-600 break-words" role="alert">{error}</p>{/if}
        <p class="text-xs text-muted-foreground">Uses the folder’s sharing permissions.</p>
        <Dialog.Footer>
            <Button variant="outline" onclick={() => (open = false)} disabled={busy}>Cancel</Button>
            <Button onclick={choose} disabled={busy}>{busy ? 'Working…' : 'Save'}</Button>
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
