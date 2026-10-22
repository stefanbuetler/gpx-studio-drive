<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import { Button } from '$lib/components/ui/button';
    import { Folder, ChevronRight, ArrowLeft, Plus } from '@lucide/svelte';
    import type { DriveClient, DriveGPXFile } from '$lib/drive/client';
    import { onMount } from 'svelte';
    let {
        drive,
        currentName,
        onselect,
        open = $bindable(false),
    }: {
        drive: DriveClient;
        currentName: string;
        onselect: (folder: DriveGPXFile) => Promise<void>;
        open?: boolean;
    } = $props();
    let path = $state([{ id: 'root', name: 'My Drive' }]);
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
            error = e instanceof Error ? e.message : String(e);
        } finally {
            busy = false;
        }
    }
    async function list(more = false) {
        const result = await drive.listFolders(current.id, more ? nextPage : undefined);
        folders = more ? [...folders, ...result.files] : result.files;
        nextPage = result.nextPageToken;
    }
    onMount(() => {
        void run(async () => {
            if (!drive.connected) await drive.connect();
            await list();
        });
    });
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
            <Dialog.Title>GDrive save folder</Dialog.Title>
            <Dialog.Description
                >Current save folder: {currentName}. Changing folders creates new saved copies;
                existing files stay in their original folder.</Dialog.Description
            >
        </Dialog.Header>
        <div class="flex items-center gap-2 min-w-0">
            <Button
                variant="ghost"
                size="icon"
                aria-label="Parent folder"
                disabled={busy || path.length === 1}
                onclick={back}><ArrowLeft class="size-4" /></Button
            >
            <Folder class="size-4 shrink-0" /><span
                class="truncate"
                title={path.map((folder) => folder.name).join(' / ')}
                >{path.map((folder) => folder.name).join(' / ')}</span
            >
        </div>
        {#if !drive.searchesAllDrive}
            <Button
                variant="outline"
                disabled={busy}
                onclick={() =>
                    run(async () => {
                        await drive.connect(true);
                        await list();
                    })}>Browse all GDrive folders</Button
            >
            <p class="text-xs text-muted-foreground">
                Browsing existing folders requires Google read access. You can also create a new
                folder without it.
            </p>
        {/if}
        <input
            class="w-full rounded border bg-background px-3 py-2 text-sm"
            aria-label="Filter folders"
            placeholder="Filter folders…"
            bind:value={filter}
        />
        <div class="max-h-64 overflow-y-auto rounded border min-h-16" aria-label="GDrive folders">
            {#each filtered as folder (folder.id)}
                <button
                    class="flex w-full items-center gap-2 p-2 text-left text-sm hover:bg-secondary disabled:opacity-50"
                    disabled={busy}
                    onclick={() => enter(folder)}
                >
                    <Folder class="size-4 shrink-0" /><span class="truncate flex-1"
                        >{folder.name}</span
                    ><ChevronRight class="size-4 shrink-0" />
                </button>
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
                placeholder="New folder name"
                maxlength="200"
                bind:value={name}
                disabled={busy}
            />
            <Button type="submit" variant="outline" disabled={busy || !name.trim()}
                ><Plus class="size-4 mr-1" />Create folder</Button
            >
        </form>
        <p class="text-xs text-muted-foreground">
            Saved files inherit the folder’s sharing permissions.
        </p>
        {#if error}<p class="text-sm text-red-600 break-words" role="alert">{error}</p>{/if}
        <Dialog.Footer>
            <Button variant="outline" onclick={() => (open = false)} disabled={busy}>Cancel</Button>
            <Button onclick={choose} disabled={busy}>{busy ? 'Working…' : 'Use this folder'}</Button
            >
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
