<script lang="ts">
    import { ScrollArea } from '$lib/components/ui/scroll-area/index';
    import * as ContextMenu from '$lib/components/ui/context-menu';
    import FileListNode from './FileListNode.svelte';
    import { onMount, setContext } from 'svelte';
    import { ListFileItem, ListLevel, ListRootItem } from './file-list';
    import {
        ClipboardPaste,
        Cloud,
        FileStack,
        FolderOpen,
        Plus,
        FolderX,
        FileX,
        SaveAll,
    } from '@lucide/svelte';
    import Shortcut from '$lib/components/Shortcut.svelte';
    import { i18n } from '$lib/i18n.svelte';
    import { fileStateCollection } from '$lib/logic/file-state';
    import {
        createFile,
        pasteSelection,
        fileActions,
        triggerFileInput,
    } from '$lib/logic/file-actions';
    import { selection, copied } from '$lib/logic/selection';
    import { toast } from 'svelte-sonner';
    import { fileActionManager } from '$lib/logic/file-action-manager';
    import { driveBatchActions, cloudFiles, driveBrowserOpen } from '$lib/drive/browser';
    import { boundsManager } from '$lib/logic/bounds';
    import { tick } from 'svelte';
    import { allowedPastes } from './sortable-file-list';

    let {
        orientation,
        recursive = false,
        class: className = '',
        style = '',
    }: {
        orientation: 'vertical' | 'horizontal';
        recursive?: boolean;
        class?: string;
        style?: string;
    } = $props();

    const localFiles = $derived(
        new Map([...$fileStateCollection].filter(([id]) => !$cloudFiles[id]))
    );
    const cloudFileList = $derived(
        new Map([...$fileStateCollection].filter(([id]) => !!$cloudFiles[id]))
    );
    let closing = $state(false);
    const selectedIds = $derived([
        ...new Set($selection.getSelected().map((item) => item.getFileId())),
    ]);
    const selectedLocal = $derived(selectedIds.filter((id) => localFiles.has(id)));
    const selectedCloud = $derived(selectedIds.filter((id) => cloudFileList.has(id)));
    async function closeFiles(ids: string[]) {
        if (closing || $driveBatchActions.busy) return;
        if (!ids.length) return;
        closing = true;
        try {
            if (!(await fileActions.closeFiles(ids))) return;
            toast.success(`Closed ${ids.length} ${ids.length === 1 ? 'file' : 'files'}`, {
                action: { label: 'Undo', onClick: () => fileActionManager.undo() },
            });
        } catch {
            toast.error('Could not close files.');
        } finally {
            closing = false;
        }
    }

    setContext('orientation', orientation);
    setContext('recursive', recursive);

    onMount(() => {
        if (orientation === 'horizontal') {
            selection.update(($selection) => {
                $selection.forEach((item) => {
                    if (!(item instanceof ListFileItem)) {
                        $selection.toggle(item);
                        $selection.set(new ListFileItem(item.getFileId()), true);
                    }
                });
                return $selection;
            });
        }
        let previous: string | undefined;
        return selection.subscribe(($selection) => {
            const selected = $selection.getSelected();
            const signature = selected
                .map((item) => item.getFullId())
                .sort()
                .join(',');
            if (previous !== undefined && previous !== signature)
                void tick().then(() => boundsManager.centerMapOnSelection());
            previous = signature;
        });
    });
</script>

{#snippet treeAction(
    label: string,
    description: string,
    disabled: boolean,
    run: () => void,
    Icon: typeof FolderOpen
)}
    <span class="relative inline-flex group/file-action">
        <button
            class="inline-flex size-6 items-center justify-center rounded-md hover:bg-secondary disabled:opacity-40"
            aria-label={label}
            aria-describedby={`file-action-${label.replaceAll(' ', '-')}`}
            {disabled}
            onclick={run}><Icon class="size-4" /></button
        >
        <span
            id={`file-action-${label.replaceAll(' ', '-')}`}
            role="tooltip"
            class="pointer-events-none absolute -right-2 top-full z-50 mt-1 hidden w-40 rounded-md bg-foreground px-2 py-1.5 text-center text-xs font-normal text-background shadow-md group-hover/file-action:block group-focus-within/file-action:block"
            >{description}</span
        >
    </span>
{/snippet}

{#snippet sectionActions(group: 'local' | 'cloud', ids: string[], selected: string[])}
    <div
        class="flex shrink-0 items-center"
        role="group"
        aria-label={`${group === 'local' ? 'Local' : 'Cloud'} file actions`}
    >
        {@render treeAction(
            `Open ${group} file`,
            group === 'local'
                ? 'Open GPX files from your device.'
                : 'Browse GDrive and open GPX files.',
            closing || $driveBatchActions.busy,
            () => {
                if (group === 'local') triggerFileInput();
                else driveBrowserOpen.set(true);
            },
            FolderOpen
        )}
        {#if group === 'cloud'}
            {@render treeAction(
                'Save all cloud files',
                'Save changes to all cloud files in GDrive. Files stay open.',
                closing || $driveBatchActions.busy || !ids.length,
                () => $driveBatchActions.saveAll?.(ids),
                SaveAll
            )}
        {/if}
        {@render treeAction(
            `Close selected ${group} files`,
            selected.length
                ? `Close selected ${group} files (asks about unsaved cloud changes).`
                : `Select ${group} files to close.`,
            closing || $driveBatchActions.busy || !selected.length,
            () => closeFiles(selected),
            FileX
        )}
        {@render treeAction(
            `Close all ${group} files`,
            `Close all ${group} files (asks about unsaved cloud changes).`,
            closing || $driveBatchActions.busy || !ids.length,
            () => closeFiles(ids),
            FolderX
        )}
    </div>
{/snippet}

<ScrollArea
    class="shrink-0 {orientation === 'vertical' ? 'p-0 pr-3' : 'h-10 px-1'}"
    {orientation}
    scrollbarXClasses={orientation === 'vertical' ? '' : 'hidden'}
    scrollbarYClasses={orientation === 'vertical' ? '' : ''}
>
    <div
        class="flex {orientation === 'vertical'
            ? 'flex-col py-1 pl-1 min-h-screen'
            : 'flex-row'} {className ?? ''}"
        {style}
    >
        {#if orientation === 'vertical'}
            <p class="px-2 py-1 text-xs text-muted-foreground">
                Open files · {$fileStateCollection.size}
            </p>
            <section aria-label="Local files" data-file-group="local">
                <div class="flex items-center justify-between gap-1 px-2 pt-2 pb-1">
                    <h2 class="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                        <FolderOpen class="size-4 shrink-0" /><span>Local files</span><span
                            class="text-xs text-muted-foreground">({localFiles.size})</span
                        >
                    </h2>
                    {@render sectionActions('local', [...localFiles.keys()], selectedLocal)}
                </div>
                <FileListNode node={localFiles} item={new ListRootItem()} />
                {#if !localFiles.size}<p class="px-2 py-2 text-xs text-muted-foreground">
                        No local files open
                    </p>{/if}
            </section>
            <section aria-label="Cloud files" data-file-group="gdrive" class="mt-3 border-t pt-2">
                <div class="flex items-center justify-between gap-1 px-2 pb-1">
                    <h2 class="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                        <Cloud class="size-4 shrink-0" /><span>Cloud files</span><span
                            class="text-xs text-muted-foreground">({cloudFileList.size})</span
                        >
                    </h2>
                    {@render sectionActions('cloud', [...cloudFileList.keys()], selectedCloud)}
                </div>
                {#if cloudFileList.size}
                    <h3 class="px-2 py-1 text-xs font-medium text-muted-foreground">GDrive</h3>
                    <FileListNode node={cloudFileList} item={new ListRootItem()} />
                {:else}<p class="px-2 py-2 text-xs text-muted-foreground">
                        Open or save a file in GDrive to see it here.
                    </p>{/if}
            </section>
        {:else}
            <FileListNode node={$fileStateCollection} item={new ListRootItem()} />
        {/if}
        {#if orientation === 'vertical'}
            <ContextMenu.Root>
                <ContextMenu.Trigger class="grow" />
                <ContextMenu.Content>
                    <ContextMenu.Item onclick={createFile}>
                        <Plus size="16" />
                        {i18n._('menu.new_file')}
                        <Shortcut key="+" ctrl={true} />
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                        onclick={() => selection.selectAll()}
                        disabled={$fileStateCollection.size === 0}
                    >
                        <FileStack size="16" />
                        {i18n._('menu.select_all')}
                        <Shortcut key="A" ctrl={true} />
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                        disabled={$copied === undefined ||
                            $copied.length === 0 ||
                            !allowedPastes[$copied[0].level].includes(ListLevel.ROOT)}
                        onclick={pasteSelection}
                    >
                        <ClipboardPaste size="16" />
                        {i18n._('menu.paste')}
                        <Shortcut key="V" ctrl={true} />
                    </ContextMenu.Item>
                </ContextMenu.Content>
            </ContextMenu.Root>
        {/if}
    </div>
</ScrollArea>
