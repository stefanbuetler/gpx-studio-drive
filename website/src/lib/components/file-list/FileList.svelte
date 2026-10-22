<script lang="ts">
    import { ScrollArea } from '$lib/components/ui/scroll-area/index';
    import * as ContextMenu from '$lib/components/ui/context-menu';
    import FileListNode from './FileListNode.svelte';
    import { onMount, setContext } from 'svelte';
    import { ListFileItem, ListLevel, ListRootItem } from './file-list';
    import {
        ClipboardPaste,
        FileStack,
        FolderOpen,
        Plus,
        SaveAll,
        FolderX,
        LoaderCircle,
    } from '@lucide/svelte';
    import Shortcut from '$lib/components/Shortcut.svelte';
    import { i18n } from '$lib/i18n.svelte';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { createFile, pasteSelection, fileActions } from '$lib/logic/file-actions';
    import { selection, copied } from '$lib/logic/selection';
    import { toast } from 'svelte-sonner';
    import { fileActionManager } from '$lib/logic/file-action-manager';
    import { driveBatchActions } from '$lib/drive/browser';
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

    let closing = $state(false);
    async function closeAll() {
        if (closing || $driveBatchActions.busy) return;
        const ids = [...$fileStateCollection.keys()];
        if (!ids.length) return;
        closing = true;
        try {
            await fileActions.closeFiles(ids);
            toast.success(`Closed ${ids.length} local ${ids.length === 1 ? 'file' : 'files'}`, {
                description: 'Local copies closed without saving to GDrive.',
                action: { label: 'Undo', onClick: () => fileActionManager.undo() },
            });
        } catch {
            toast.error('Could not close local files. Try again.');
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
            <div
                class="flex items-center gap-2 px-2 pt-2 pb-1 text-sm font-semibold"
                role="heading"
                aria-level="2"
            >
                <FolderOpen class="size-4 shrink-0" />
                <span>Local files</span>
                <span class="text-xs font-normal text-muted-foreground"
                    >({$fileStateCollection.size})</span
                >
                <button
                    class="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-secondary disabled:opacity-40"
                    aria-label="Save all to GDrive"
                    title="Save all to GDrive"
                    disabled={closing ||
                        $driveBatchActions.busy ||
                        !$driveBatchActions.saveAll ||
                        !$fileStateCollection.size}
                    onclick={() => $driveBatchActions.saveAll?.()}
                >
                    {#if $driveBatchActions.busy}<LoaderCircle
                            class="size-4 animate-spin"
                        />{:else}<SaveAll class="size-4" />{/if}
                </button>
                <button
                    class="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-secondary disabled:opacity-40"
                    aria-label="Close all local files"
                    title="Close all local files without saving"
                    disabled={closing || $driveBatchActions.busy || !$fileStateCollection.size}
                    onclick={closeAll}
                >
                    <FolderX class="size-4" />
                </button>
            </div>
            <p class="px-2 mb-2 text-[11px] text-muted-foreground">
                Working copies in this browser
            </p>
        {/if}
        <FileListNode node={$fileStateCollection} item={new ListRootItem()} />
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
