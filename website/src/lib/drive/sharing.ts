import { get } from 'svelte/store';
import { mode } from 'mode-watcher';
import { settings } from '$lib/logic/settings';
import { map } from '$lib/components/map/map';
import {
    overlays,
    defaultOverlayTree,
    defaultOverpassTree,
    overpassTree,
    type LayerTreeType,
    type CustomLayer,
} from '$lib/assets/layers';
import { getLayers } from '$lib/components/map/layer-control/utils';
import {
    allowedEmbeddingBasemaps,
    getCleanedEmbeddingOptions,
    getMergedEmbeddingOptions,
    type EmbeddingOptions,
} from '$lib/components/embedding/embedding';

// Capture presentation only: never local file IDs, account information, or OAuth tokens.
export function captureSharedView() {
    const basemap = get(settings.currentBasemap);
    const activeOverlays = Object.fromEntries(
        Object.entries(getLayers(get(settings.currentOverlays) ?? {})).filter(([, on]) => on)
    );
    const customLayers: Record<string, CustomLayer> = {};
    const localLayers = get(settings.customLayers);
    for (const id of [basemap, ...Object.keys(activeOverlays)]) {
        if (localLayers[id]) customLayers[id] = localLayers[id];
        else if (id.startsWith('extension-') && overlays[id]) {
            customLayers[id] = {
                id,
                name: id,
                tileUrls: [],
                maxZoom: 22,
                layerType: 'overlay',
                resourceType: 'vector',
                value: overlays[id],
            };
        }
    }
    if (!allowedEmbeddingBasemaps.includes(basemap) && !customLayers[basemap]) {
        throw new Error(
            'This map layer is unavailable for embedding. Choose another basemap before sharing.'
        );
    }
    const datasets = get(settings.additionalDatasets);
    const currentMap = get(map);
    const options = getMergedEmbeddingOptions({
        basemap,
        overlays: activeOverlays,
        overpassQueries: get(settings.currentOverpassQueries) ?? {},
        opacities: get(settings.opacities),
        customLayers,
        terrainSource: get(settings.terrainSource),
        defaultWidth: get(settings.defaultWidth),
        defaultOpacity: get(settings.defaultOpacity),
        pitch: currentMap?.getPitch() ?? 0,
        bearing: currentMap?.getBearing() ?? 0,
        distanceMarkers: get(settings.distanceMarkers),
        directionMarkers: get(settings.directionMarkers),
        distanceUnits: get(settings.distanceUnits),
        velocityUnits: get(settings.velocityUnits),
        temperatureUnits: get(settings.temperatureUnits),
        theme: mode.current ?? 'system',
        elevation: {
            show: get(settings.elevationProfile),
            height: get(settings.bottomPanelSize),
            fill: get(settings.elevationFill) ?? 'none',
            speed: datasets.includes('speed'),
            hr: datasets.includes('hr'),
            cad: datasets.includes('cad'),
            temp: datasets.includes('atemp'),
            power: datasets.includes('power'),
        },
    });
    return getCleanedEmbeddingOptions(options);
}

function restoreLayerTree(template: LayerTreeType, selection: LayerTreeType): LayerTreeType {
    const selected = getLayers(selection);
    const known = getLayers(template);
    const restore = (tree: LayerTreeType): LayerTreeType =>
        Object.fromEntries(
            Object.entries(tree).map(([id, value]) => [
                id,
                typeof value === 'boolean' ? selected[id] === true : restore(value),
            ])
        );
    // Keep built-in selections in their normal hierarchy. Duplicate flat IDs would
    // otherwise be overwritten by unchecked children when the tree is flattened.
    return {
        ...restore(template),
        ...Object.fromEntries(Object.entries(selected).filter(([id]) => !Object.hasOwn(known, id))),
    };
}

export function applySharedLayers(options: EmbeddingOptions) {
    settings.customLayers.set(options.customLayers);
    if (options.customLayers[options.basemap]) {
        settings.selectedBasemapTree.set({
            ...get(settings.selectedBasemapTree),
            [options.basemap]: true,
        });
    }
    const visibleOverlays = { ...getLayers(defaultOverlayTree), ...getLayers(options.overlays) };
    settings.selectedOverlayTree.set(restoreLayerTree(defaultOverlayTree, visibleOverlays));
    settings.currentOverlays.set(restoreLayerTree(defaultOverlayTree, options.overlays));
    settings.currentOverpassQueries.set(restoreLayerTree(overpassTree, options.overpassQueries));
    settings.selectedOverpassTree.set(
        restoreLayerTree(overpassTree, {
            ...getLayers(defaultOverpassTree),
            ...getLayers(options.overpassQueries),
        })
    );
    settings.opacities.set(options.opacities);
    settings.terrainSource.set(options.terrainSource);
    settings.defaultWidth.set(options.defaultWidth);
    settings.defaultOpacity.set(options.defaultOpacity);
}

export function embedURLFromShare(link: string): string {
    const url = new URL(link);
    if (/^\/s\/[a-zA-Z0-9_-]{16}$/.test(url.pathname)) {
        url.search = '';
        url.hash = '';
        url.searchParams.set('embed', '1');
        return url.href;
    }
    const id = url.searchParams.get('id')!;
    const resourceKey = url.searchParams.get('resourcekey');
    const view = JSON.parse(url.searchParams.get('view') || '{}');
    const options = {
        ...view,
        files: [],
        ids: [id],
        ...(resourceKey ? { resourceKeys: { [id]: resourceKey } } : {}),
    };
    url.pathname = url.pathname.replace(/\/share$/, '/embed');
    url.search = '';
    url.hash = '';
    url.searchParams.set('options', JSON.stringify(options));
    url.searchParams.set('fit', 'route');
    return url.href;
}

export function iframeCode(link: string): string {
    const src = embedURLFromShare(link)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
    return `<iframe src="${src}" title="GPX route map" width="100%" height="500" style="border:0;" loading="lazy" allowfullscreen></iframe>`;
}
