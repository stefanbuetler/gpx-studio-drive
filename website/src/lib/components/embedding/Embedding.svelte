<script lang="ts">
    import GPXLayers from '$lib/components/map/gpx-layer/GPXLayers.svelte';
    import ElevationProfile from '$lib/components/elevation-profile/ElevationProfile.svelte';
    import FileList from '$lib/components/file-list/FileList.svelte';
    import GPXStatistics from '$lib/components/GPXStatistics.svelte';
    import Map from '$lib/components/map/Map.svelte';
    import LayerControl from '$lib/components/map/layer-control/LayerControl.svelte';
    import OpenIn from '$lib/components/embedding/OpenIn.svelte';
    import { downloadPublicGPX } from '$lib/drive/public';
    import { writable } from 'svelte/store';
    import type { GPXFile } from 'gpx';
    import {
        allowedEmbeddingBasemaps,
        getFilesFromEmbeddingOptions,
        type EmbeddingOptions,
    } from './embedding';
    import { setMode } from 'mode-watcher';
    import { settings } from '$lib/logic/settings';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { gpxStatistics, hoveredPoint, slicedGPXStatistics } from '$lib/logic/statistics';
    import { loadFile } from '$lib/logic/file-actions';
    import { selection } from '$lib/logic/selection';
    import { untrack } from 'svelte';
    import { isSelected, toggle } from '$lib/components/map/layer-control/utils';
    import { map } from '$lib/components/map/map';
    import { applySharedLayers } from '$lib/drive/sharing';
    import { boundsManager } from '$lib/logic/bounds';

    let {
        useHash = true,
        options = $bindable(),
        hash = $bindable(),
    }: { useHash?: boolean; options: EmbeddingOptions; hash: string } = $props();

    let loading = $state(false);
    let loadError = $state('');
    let loadVersion = 0;
    let additionalDatasets = writable<string[]>([]);
    let elevationFill = writable<'slope' | 'surface' | 'highway' | undefined>(undefined);

    const {
        currentBasemap,
        selectedBasemapTree,
        distanceUnits,
        velocityUnits,
        temperatureUnits,
        fileOrder,
        distanceMarkers,
        directionMarkers,
    } = settings;

    settings.initialize();

    async function applyOptions() {
        const version = ++loadVersion;
        loading = true;
        loadError = '';
        try {
            applySharedLayers(options);
            if (
                allowedEmbeddingBasemaps.includes(options.basemap) ||
                options.customLayers[options.basemap]
            ) {
                $currentBasemap = options.basemap;
            }
            if (!isSelected($selectedBasemapTree, options.basemap)) {
                $selectedBasemapTree = toggle($selectedBasemapTree, options.basemap);
            }
            $distanceMarkers = options.distanceMarkers;
            $directionMarkers = options.directionMarkers;
            $distanceUnits = options.distanceUnits;
            $velocityUnits = options.velocityUnits;
            $temperatureUnits = options.temperatureUnits;
            setMode(options.theme);

            additionalDatasets.set(
                [
                    options.elevation.speed ? 'speed' : null,
                    options.elevation.hr ? 'hr' : null,
                    options.elevation.cad ? 'cad' : null,
                    options.elevation.temp ? 'atemp' : null,
                    options.elevation.power ? 'power' : null,
                ].filter((dataset) => dataset !== null)
            );
            elevationFill.set(
                options.elevation.fill == 'none' ? undefined : options.elevation.fill
            );

            const files = (
                await Promise.all(
                    getFilesFromEmbeddingOptions(options).map(async (url) =>
                        loadFile(await downloadPublicGPX(url))
                    )
                )
            ).filter((file): file is GPXFile => file !== null);
            if (version !== loadVersion) return;
            let ids: string[] = [];
            files.forEach((file, index) => {
                let id = `gpx-${index}-embed`;
                file._data.id = id;
                ids.push(id);
            });
            fileStateCollection.setEmbeddedFiles(files);
            $fileOrder = ids;
            selection.selectAll();
            map.onLoad(() => {
                boundsManager.fitBoundsOnLoad(ids, {
                    pitch: options.pitch,
                    bearing: options.bearing,
                });
            });
        } catch (error) {
            if (version === loadVersion)
                loadError = error instanceof Error ? error.message : 'Could not load this route.';
        } finally {
            if (version === loadVersion) loading = false;
        }
    }

    $effect(() => {
        options;
        untrack(applyOptions);
    });
</script>

<div class="absolute flex flex-col h-full w-full border rounded-xl overflow-clip">
    {#if loading}<p
            class="absolute left-1/2 top-4 -translate-x-1/2 z-40 rounded bg-background p-3 shadow"
            role="status"
        >
            Loading shared route…
        </p>{/if}
    {#if loadError}<p
            class="absolute left-1/2 top-16 -translate-x-1/2 z-40 rounded bg-background p-3 shadow max-w-md"
            role="alert"
        >
            {loadError}
        </p>{/if}
    <div class="grow relative">
        <Map
            class="h-full {$fileStateCollection.size > 1 ? 'horizontal' : ''}"
            maptilerKey={options.key}
            geocoder={false}
            geolocate={true}
            hash={useHash}
        />
        <OpenIn files={options.files} ids={options.ids} resourceKeys={options.resourceKeys} />
        <LayerControl />
        <GPXLayers />
        {#if $fileStateCollection.size > 1}
            <div class="h-10 -translate-y-10 w-full pointer-events-none absolute z-30">
                <FileList orientation="horizontal" />
            </div>
        {/if}
    </div>
    <div
        class="{options.elevation.show ? '' : 'h-10'} flex flex-row gap-2 p-2 sm:px-4"
        style={options.elevation.show ? `height: ${options.elevation.height}px` : ''}
    >
        <GPXStatistics
            {gpxStatistics}
            {slicedGPXStatistics}
            orientation={options.elevation.show ? 'vertical' : 'horizontal'}
        />
        {#if options.elevation.show}
            <ElevationProfile
                {gpxStatistics}
                {slicedGPXStatistics}
                {hoveredPoint}
                {additionalDatasets}
                {elevationFill}
                showControls={options.elevation.controls}
            />
        {/if}
    </div>
</div>
