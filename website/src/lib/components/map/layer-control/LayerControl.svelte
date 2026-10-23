<script lang="ts">
    import CustomControl from '$lib/components/map/custom-control/CustomControl.svelte';
    import LayerTree from './LayerTree.svelte';
    import { OverpassLayer } from './overpass-layer';
    import { Separator } from '$lib/components/ui/separator';
    import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
    import { Layers } from '@lucide/svelte';
    import { settings } from '$lib/logic/settings';
    import { map } from '$lib/components/map/map';
    import { onDestroy } from 'svelte';
    import { writable } from 'svelte/store';
    const poiStatus = writable({ zoomRequired: true, loading: false, error: '' });
    let unsubscribeStatus: (() => void) | undefined;
    import type { Map } from 'maplibre-gl';

    let container: HTMLDivElement;
    let overpassLayer: OverpassLayer;

    const {
        currentBasemap,
        previousBasemap,
        currentOverlays,
        currentOverpassQueries,
        selectedBasemapTree,
        selectedOverlayTree,
        selectedOverpassTree,
    } = settings;

    map.onLoad((_map: Map) => {
        if (overpassLayer) {
            overpassLayer.remove();
        }
        overpassLayer = new OverpassLayer(_map, map.layerEventManager!);
        unsubscribeStatus?.();
        unsubscribeStatus = overpassLayer.status.subscribe(poiStatus.set);
        overpassLayer.add();
    });

    onDestroy(() => {
        unsubscribeStatus?.();
        overpassLayer?.remove();
    });

    let open = $state(false);
    function openLayerControl() {
        open = true;
    }
    function closeLayerControl() {
        open = false;
    }
    let cancelEvents = $state(false);
</script>

<CustomControl class="group min-w-[29px] min-h-[29px] overflow-hidden">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        bind:this={container}
        class="size-full"
        onmouseenter={openLayerControl}
        onmouseleave={closeLayerControl}
        onpointerenter={() => {
            if (!open) {
                cancelEvents = true;
                openLayerControl();
                setTimeout(() => {
                    cancelEvents = false;
                }, 500);
            }
        }}
    >
        <div
            class="flex flex-row justify-center items-center delay-100 transition-[opacity] duration-0 {open
                ? 'opacity-0 size-0 delay-0'
                : 'w-[29px] h-[29px]'}"
        >
            <Layers size="20" />
        </div>
        <div
            class="transition-[grid-template-rows grid-template-cols] grid grid-rows-[0fr] grid-cols-[0fr] duration-150 h-full {open
                ? 'grid-rows-[1fr] grid-cols-[1fr]'
                : ''} {cancelEvents ? 'pointer-events-none' : ''}"
        >
            <ScrollArea class="overflow-hidden">
                <div class="h-fit">
                    <div class="p-2 ml-1">
                        <LayerTree
                            layerTree={$selectedBasemapTree}
                            name="basemaps"
                            selected={$currentBasemap}
                            onselect={(value) => {
                                $previousBasemap = $currentBasemap;
                                $currentBasemap = value;
                            }}
                        />
                    </div>
                    <Separator class="w-full" />
                    <div class="p-2 ml-1">
                        {#if $currentOverlays}
                            <LayerTree
                                layerTree={$selectedOverlayTree}
                                name="overlays"
                                multiple={true}
                                bind:checked={$currentOverlays}
                            />
                        {/if}
                    </div>
                    <Separator class="w-full" />
                    <div class="p-2 ml-1">
                        {#if $currentOverpassQueries}
                            <LayerTree
                                layerTree={$selectedOverpassTree}
                                name="overpass"
                                multiple={true}
                                bind:checked={$currentOverpassQueries}
                            />
                            {#if $poiStatus.zoomRequired}
                                <p class="mt-2 max-w-56 text-xs text-muted-foreground">
                                    Zoom in to level 12 to see points of interest.
                                    <button
                                        class="underline"
                                        onclick={() => overpassLayer.map.easeTo({ zoom: 12 })}
                                        >Zoom in</button
                                    >
                                </p>
                            {:else if $poiStatus.error}
                                <p role="status" class="mt-2 max-w-56 text-xs text-destructive">
                                    {$poiStatus.error}
                                    <button
                                        class="underline"
                                        onclick={() => overpassLayer.queryIfNeeded()}>Retry</button
                                    >
                                </p>
                            {:else if $poiStatus.loading}
                                <p role="status" class="mt-2 text-xs text-muted-foreground">
                                    Loading points of interest…
                                </p>
                            {/if}
                        {/if}
                    </div>
                </div>
            </ScrollArea>
        </div>
    </div>
</CustomControl>

<svelte:window
    on:click={(e: MouseEvent) => {
        const target = e.target as Node | null;
        if (open && !cancelEvents && target && container && !container.contains(target)) {
            closeLayerControl();
        }
    }}
/>
