<script lang="ts">
    import {
        driveLocalActions,
        cloudFiles,
        cloudSaveStatus,
        saveOpenFile,
    } from '$lib/drive/browser';
    import { Button } from '$lib/components/ui/button';
    import * as ContextMenu from '$lib/components/ui/context-menu';
    import Shortcut from '$lib/components/Shortcut.svelte';
    import {
        Copy,
        Info,
        MapPin,
        PaintBucket,
        Plus,
        Trash2,
        Waypoints,
        Eye,
        EyeOff,
        ClipboardCopy,
        ClipboardPaste,
        Maximize,
        Scissors,
        FileStack,
        FileX,
        Save,
        Share2,
        Check,
        LoaderCircle,
        CircleAlert,
    } from '@lucide/svelte';
    import {
        ListFileItem,
        ListLevel,
        ListTrackItem,
        ListWaypointItem,
        type ListItem,
    } from './file-list';
    import { getContext, tick } from 'svelte';
    import { GPXTreeElement, Track, type AnyGPXTreeElement, Waypoint, GPXFile } from 'gpx';
    import { i18n } from '$lib/i18n.svelte';
    import MetadataDialog from '$lib/components/file-list/metadata/MetadataDialog.svelte';
    import { editMetadata } from '$lib/components/file-list/metadata/utils.svelte';
    import StyleDialog from '$lib/components/file-list/style/StyleDialog.svelte';
    import { editStyle } from '$lib/components/file-list/style/utils.svelte';
    import { getSymbolKey, symbols } from '$lib/assets/symbols';
    import { selection, copied, cut } from '$lib/logic/selection';
    import { fileActions, pasteSelection } from '$lib/logic/file-actions';
    import { allHidden } from '$lib/logic/hidden';
    import { boundsManager } from '$lib/logic/bounds';
    import { gpxColors, gpxLayers } from '$lib/components/map/gpx-layer/gpx-layers';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { waypointPopup } from '$lib/components/map/gpx-layer/gpx-layer-popup';
    import { allowedPastes } from './sortable-file-list';

    let {
        node,
        item,
        label,
    }: {
        node: GPXTreeElement<AnyGPXTreeElement> | Waypoint[] | Waypoint;
        item: ListItem;
        label: string | undefined;
    } = $props();

    let orientation = getContext<'vertical' | 'horizontal'>('orientation');
    let embedding = getContext<boolean>('embedding');

    let contextOpen = $state(false);
    async function pasteFromMenu() {
        // Close the portal before paste replaces the GPX tree beneath it.
        // Otherwise its old menu can intercept the next paste or drag.
        contextOpen = false;
        await tick();
        pasteSelection();
    }
    let singleSelection = $derived($selection.size === 1);

    let nodeColors: string[] = $derived.by(() => {
        let colors: string[] = [];
        if (node) {
            if (node instanceof GPXFile) {
                let defaultColor = $gpxColors.get(item.getFileId());
                let style = node.getStyle(defaultColor);
                colors = style.color;
            } else if (node instanceof Track) {
                let style = node.getStyle();
                if (
                    style &&
                    style['gpx_style:color'] &&
                    !colors.includes(style['gpx_style:color'])
                ) {
                    colors.push(style['gpx_style:color']);
                }
                if (colors.length === 0) {
                    let defaultColor = $gpxColors.get(item.getFileId());
                    if (defaultColor) {
                        colors.push(defaultColor);
                    }
                }
            }
        }
        return colors;
    });

    let symbolKey = $derived(node instanceof Waypoint ? getSymbolKey(node.sym) : undefined);

    let openEditMetadata: boolean = $derived(
        editMetadata.current && singleSelection && $selection.has(item)
    );
    let openEditStyle: boolean = $derived(
        editStyle.current &&
            $selection.has(item) &&
            $selection.getSelected().findIndex((i) => i.getFullId() === item.getFullId()) === 0
    );

    let hidden = $derived(
        Array.isArray(node)
            ? node.every((waypoint) => waypoint._data.hidden)
            : item.level === ListLevel.WAYPOINTS
              ? node._data.hiddenWpt
              : node._data.hidden
    );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<ContextMenu.Root
    bind:open={contextOpen}
    onOpenChange={(open) => {
        if (open) {
            if (!$selection.has(item)) {
                selection.selectItem(item);
            }
        }
    }}
>
    <ContextMenu.Trigger class="grow truncate">
        <Button
            variant="ghost"
            aria-label={label}
            title={item instanceof ListFileItem
                ? $cloudFiles[item.getFileId()]?.remoteName
                    ? 'GDrive file — writable files save automatically'
                    : 'Local file — only in this browser'
                : undefined}
            onclick={() => {
                if (item instanceof ListFileItem && $selection.has(item))
                    boundsManager.centerMapOnSelection();
            }}
            class="relative w-full p-0 overflow-hidden border-none focus-visible:ring-0 focus-visible:ring-offset-0 flex flex-row {orientation ===
            'vertical'
                ? 'h-7'
                : 'h-9 px-1.5'} pointer-events-auto"
        >
            {#if item instanceof ListFileItem || item instanceof ListTrackItem}
                <MetadataDialog bind:open={openEditMetadata} {node} {item} />
                <StyleDialog bind:open={openEditStyle} {item} />
            {/if}
            {#if item.level === ListLevel.FILE || item.level === ListLevel.TRACK}
                <div
                    class="absolute {orientation === 'vertical'
                        ? 'top-0 bottom-0 right-0 w-1'
                        : 'top-0 h-1 left-0 right-0'}"
                    style="background:linear-gradient(to {orientation === 'vertical'
                        ? 'bottom'
                        : 'right'},{nodeColors
                        .map(
                            (c, i) =>
                                `${c} ${Math.floor((100 * i) / nodeColors.length)}% ${Math.floor((100 * (i + 1)) / nodeColors.length)}%`
                        )
                        .join(',')})"
                ></div>
            {/if}
            <span
                class="grow text-left truncate ml-1 flex flex-row items-center {hidden
                    ? 'text-muted-foreground'
                    : ''} {$cut && $copied?.some((i) => i.getFullId() === item.getFullId())
                    ? 'text-muted-foreground'
                    : ''}"
                oncontextmenu={(e) => {
                    if (embedding) {
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                    if (e.ctrlKey) {
                        // Add to selection instead of opening context menu
                        e.preventDefault();
                        e.stopPropagation();
                        $selection.toggle(item);
                        $selection = $selection;
                    }
                }}
                onmouseenter={() => {
                    if (item instanceof ListWaypointItem) {
                        let layer = gpxLayers.getLayer(item.getFileId());
                        let file = fileStateCollection.getFile(item.getFileId());
                        if (layer && file) {
                            let waypoint = file.wpt[item.getWaypointIndex()];
                            if (waypoint && !waypoint._data.hidden) {
                                waypointPopup?.setItem({
                                    item: waypoint,
                                    fileId: item.getFileId(),
                                });
                            }
                        }
                    }
                }}
                onmouseleave={() => {
                    if (item instanceof ListWaypointItem) {
                        let layer = gpxLayers.getLayer(item.getFileId());
                        if (layer) {
                            waypointPopup?.setItem(null);
                        }
                    }
                }}
            >
                {#if item.level === ListLevel.SEGMENT}
                    <Waypoints size="16" class="mx-1 shrink-0" />
                {:else if item.level === ListLevel.WAYPOINT}
                    {#if symbolKey && symbols[symbolKey].icon}
                        {@const SymbolIcon = symbols[symbolKey].icon}
                        <SymbolIcon size="16" class="mx-1 shrink-0" />
                    {:else}
                        <MapPin size="16" class="mx-1 shrink-0" />
                    {/if}
                {/if}
                <span
                    class="grow select-none truncate {orientation === 'vertical'
                        ? 'last:mr-2'
                        : ''}"
                >
                    {label}
                </span>
                {#if item instanceof ListFileItem && $cloudFiles[item.getFileId()]}
                    {@const id = item.getFileId()}
                    {@const saving = $cloudSaveStatus[id]}
                    {@const state =
                        saving?.state === 'saving'
                            ? 'Saving…'
                            : saving?.state === 'error' || $cloudFiles[id].dirty
                              ? 'Unsaved changes'
                              : 'Saved'}
                    <span
                        role="status"
                        class="mx-1 shrink-0"
                        data-testid={$cloudFiles[id].dirty ? 'unsaved-cloud-file' : undefined}
                        title={saving?.message
                            ? `Could not save to GDrive. ${saving.message} Use Save to retry.`
                            : state === 'Saving…'
                              ? 'Saving changes to GDrive…'
                              : state === 'Unsaved changes'
                                ? 'Changes are stored in this browser and waiting to save to GDrive.'
                                : 'All changes saved to GDrive.'}
                    >
                        <span class="sr-only">{state}</span>
                        {#if state === 'Saving…'}<LoaderCircle
                                class="size-3.5 animate-spin text-muted-foreground"
                                aria-hidden="true"
                            />
                        {:else if state === 'Unsaved changes'}<CircleAlert
                                class="size-3.5 text-amber-600"
                                aria-hidden="true"
                            />
                        {:else}<Check
                                class="size-3.5 text-muted-foreground"
                                aria-hidden="true"
                            />{/if}
                    </span>
                {/if}
                {#if hidden}
                    <EyeOff
                        size="10"
                        class="shrink-0 size-3.5 ml-1 {orientation === 'vertical'
                            ? 'mr-3'
                            : 'mt-0.5'}"
                    />
                {/if}
            </span>
        </Button>
    </ContextMenu.Trigger>
    <ContextMenu.Content>
        {#if !embedding && item instanceof ListFileItem && $driveLocalActions[item.getFileId()]}
            {@const driveActions = $driveLocalActions[item.getFileId()]}
            <ContextMenu.Item
                disabled={driveActions.busy || !driveActions.save}
                onclick={() => saveOpenFile(item.getFileId())}
            >
                <Save size="16" />Save
            </ContextMenu.Item>
            <ContextMenu.Item
                disabled={driveActions.busy}
                onclick={() => saveOpenFile(item.getFileId(), true)}
            >
                <Save size="16" />Save as…
            </ContextMenu.Item>
            {#if driveActions.share}
                <ContextMenu.Item
                    disabled={driveActions.busy}
                    onclick={() => driveActions.share?.()}
                >
                    <Share2 size="16" />Share…
                </ContextMenu.Item>
            {/if}
            <ContextMenu.Separator />
        {/if}
        {#if item instanceof ListFileItem || item instanceof ListTrackItem}
            <ContextMenu.Item
                disabled={!singleSelection}
                onclick={() => (editMetadata.current = true)}
            >
                <Info size="16" />
                {i18n._('menu.metadata.button')}
                <Shortcut key="I" ctrl={true} />
            </ContextMenu.Item>
            <ContextMenu.Item onclick={() => (editStyle.current = true)}>
                <PaintBucket size="16" />
                {i18n._('menu.style.button')}
            </ContextMenu.Item>
        {/if}
        <ContextMenu.Item
            onclick={() => {
                if ($allHidden) {
                    fileActions.setHiddenToSelection(false);
                } else {
                    fileActions.setHiddenToSelection(true);
                }
            }}
        >
            {#if $allHidden}
                <Eye size="16" />
                {i18n._('menu.unhide')}
            {:else}
                <EyeOff size="16" />
                {i18n._('menu.hide')}
            {/if}
            <Shortcut key="H" ctrl={true} />
        </ContextMenu.Item>
        <ContextMenu.Separator />
        {#if orientation === 'vertical'}
            {#if item instanceof ListFileItem}
                <ContextMenu.Item
                    disabled={!singleSelection}
                    onclick={() => fileActions.addNewTrack(item.getFileId())}
                >
                    <Plus size="16" />
                    {i18n._('menu.new_track')}
                </ContextMenu.Item>
                <ContextMenu.Separator />
            {:else if item instanceof ListTrackItem}
                <ContextMenu.Item
                    disabled={!singleSelection}
                    onclick={() =>
                        fileActions.addNewSegment(item.getFileId(), item.getTrackIndex())}
                >
                    <Plus size="16" />
                    {i18n._('menu.new_segment')}
                </ContextMenu.Item>
                <ContextMenu.Separator />
            {/if}
        {/if}
        {#if item.level !== ListLevel.WAYPOINTS}
            <ContextMenu.Item onclick={() => selection.selectAll()}>
                <FileStack size="16" />
                {i18n._('menu.select_all')}
                <Shortcut key="A" ctrl={true} />
            </ContextMenu.Item>
        {/if}
        <ContextMenu.Item onclick={() => boundsManager.centerMapOnSelection()}>
            <Maximize size="16" />
            {i18n._('menu.center')}
            <Shortcut key="⏎" ctrl={true} />
        </ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onclick={fileActions.duplicateSelection}>
            <Copy size="16" />
            {i18n._('menu.duplicate')}
            <Shortcut key="D" ctrl={true} />
        </ContextMenu.Item>
        {#if orientation === 'vertical'}
            <ContextMenu.Item onclick={() => { contextOpen = false; selection.copySelection(); }}>
                <ClipboardCopy size="16" />
                {i18n._('menu.copy')}
                <Shortcut key="C" ctrl={true} />
            </ContextMenu.Item>
            <ContextMenu.Item onclick={() => { contextOpen = false; selection.cutSelection(); }}>
                <Scissors size="16" />
                {i18n._('menu.cut')}
                <Shortcut key="X" ctrl={true} />
            </ContextMenu.Item>
            <ContextMenu.Item
                disabled={$copied === undefined ||
                    $copied.length === 0 ||
                    !allowedPastes[$copied[0].level].includes(item.level)}
                onclick={pasteFromMenu}
            >
                <ClipboardPaste size="16" />
                {i18n._('menu.paste')}
                <Shortcut key="V" ctrl={true} />
            </ContextMenu.Item>
        {/if}
        <ContextMenu.Separator />
        <ContextMenu.Item
            onclick={item instanceof ListFileItem
                ? fileActions.deleteSelectedFiles
                : fileActions.deleteSelection}
        >
            {#if item instanceof ListFileItem}<FileX size="16" />Close{:else}<Trash2
                    size="16"
                />{i18n._('menu.delete')}{/if}
            <Shortcut key="⌫" ctrl={true} />
        </ContextMenu.Item>
    </ContextMenu.Content>
</ContextMenu.Root>
