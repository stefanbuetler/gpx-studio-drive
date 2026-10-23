import { SphericalMercator } from '@mapbox/sphericalmercator';
import { getLayers } from './utils';
import { get, writable } from 'svelte/store';
import { liveQuery } from 'dexie';
import { overpassQueryData } from '$lib/assets/layers';
import { MapPopup } from '$lib/components/map/map-popup';
import { settings } from '$lib/logic/settings';
import { db } from '$lib/db';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { ANCHOR_LAYER_KEY } from '$lib/components/map/style';
import type { MapLayerEventManager } from '$lib/components/map/map-layer-event-manager';
import { loadSVGIcon } from '$lib/utils';

const { currentOverpassQueries } = settings;

const mercator = new SphericalMercator({
    size: 256,
});

let data = writable<GeoJSON.FeatureCollection>({ type: 'FeatureCollection', features: [] });

liveQuery(() => db.overpassdata.toArray()).subscribe((pois) => {
    data.set({ type: 'FeatureCollection', features: pois.map((poi) => poi.poi) });
});

export class OverpassLayer {
    overpassUrl = '/api/pois';
    status = writable({ zoomRequired: true, loading: false, error: '' });
    private generation = 0;
    private removed = false;
    private error = '';
    private controllers = new Set<AbortController>();
    minZoom = 12;
    queryZoom = 12;
    expirationTime = 7 * 24 * 3600 * 1000;
    map: MapLibreMap;
    layerEventManager: MapLayerEventManager;
    popup: MapPopup;

    currentQueries: Set<string> = new Set();
    nextQueries: Map<string, { x: number; y: number; queries: string[] }> = new Map();

    unsubscribes: (() => void)[] = [];
    queryIfNeededBinded = this.queryIfNeeded.bind(this);
    updateBinded = this.update.bind(this);
    onHoverBinded = this.onHover.bind(this);

    constructor(map: MapLibreMap, layerEventManager: MapLayerEventManager) {
        this.map = map;
        this.layerEventManager = layerEventManager;
        this.popup = new MapPopup(map, {
            closeButton: false,
            focusAfterOpen: false,
            maxWidth: undefined,
            offset: 15,
        });
    }

    add() {
        this.map.on('moveend', this.queryIfNeededBinded);
        this.map.on('style.load', this.updateBinded);
        this.unsubscribes.push(data.subscribe(this.updateBinded));
        this.unsubscribes.push(
            currentOverpassQueries.subscribe(() => {
                this.updateBinded();
                this.queryIfNeededBinded();
            })
        );

        this.update();
    }

    queryIfNeeded() {
        this.generation++;
        this.nextQueries.clear();
        this.error = '';
        this.updateStatus();
        if (this.map.getZoom() >= this.minZoom) {
            const bounds = this.map.getBounds()?.toArray();
            if (bounds) {
                this.query([bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]]);
            }
        }
    }

    updateStatus() {
        this.status.set({
            zoomRequired: this.map.getZoom() < this.minZoom,
            loading: this.currentQueries.size > 0 || this.nextQueries.size > 0,
            error: this.error,
        });
    }

    update() {
        this.loadIcons();

        const fullData = get(data);
        const queries = getCurrentQueries();
        const d: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: fullData.features.filter((feature) =>
                queries.includes(feature.properties!.query)
            ),
        };

        try {
            let source = this.map.getSource('overpass') as GeoJSONSource | undefined;
            if (source) {
                source.setData(d);
            } else {
                this.map.addSource('overpass', {
                    type: 'geojson',
                    data: d,
                });
            }

            if (!this.map.getLayer('overpass')) {
                this.map.addLayer(
                    {
                        id: 'overpass',
                        type: 'symbol',
                        source: 'overpass',
                        layout: {
                            'icon-image': ['get', 'icon'],
                            'icon-size': 0.25,
                            'icon-padding': 0,
                            'icon-allow-overlap': ['step', ['zoom'], false, 14, true],
                        },
                    },
                    ANCHOR_LAYER_KEY.overpass
                );

                this.layerEventManager.on('mouseenter', 'overpass', this.onHoverBinded);
                this.layerEventManager.on('click', 'overpass', this.onHoverBinded);
            }
        } catch (e) {
            // No reliable way to check if the map is ready to add sources and layers
        }
    }

    remove() {
        this.removed = true;
        this.generation++;
        this.nextQueries.clear();
        this.controllers.forEach((controller) => controller.abort());
        this.popup.remove();
        this.map.off('moveend', this.queryIfNeededBinded);
        this.map.off('style.load', this.updateBinded);
        this.layerEventManager.off('mouseenter', 'overpass', this.onHoverBinded);
        this.layerEventManager.off('click', 'overpass', this.onHoverBinded);
        this.unsubscribes.forEach((unsubscribe) => unsubscribe());

        try {
            if (this.map.getLayer('overpass')) {
                this.map.removeLayer('overpass');
            }

            if (this.map.getSource('overpass')) {
                this.map.removeSource('overpass');
            }
        } catch (e) {
            // No reliable way to check if the map is ready to remove sources and layers
        }
    }

    onHover(e: any) {
        this.popup.setItem({
            item: {
                ...e.features[0].properties,
                sym: overpassQueryData[e.features[0].properties.query].symbol ?? '',
            },
        });
    }

    query(bbox: [number, number, number, number]) {
        const generation = this.generation;
        let queries = getCurrentQueries();
        if (queries.length === 0) {
            return;
        }

        let tileLimits = mercator.xyz(bbox, this.queryZoom);
        let time = Date.now();

        for (let x = tileLimits.minX; x <= tileLimits.maxX; x++) {
            for (let y = tileLimits.minY; y <= tileLimits.maxY; y++) {
                db.overpasstiles
                    .where('[x+y]')
                    .equals([x, y])
                    .toArray()
                    .then((querytiles) => {
                        if (generation !== this.generation || this.removed || this.error) return;
                        let missingQueries = queries.filter(
                            (query) =>
                                !querytiles.some(
                                    (querytile) =>
                                        querytile.query === tileCacheKey(query) &&
                                        time - querytile.time < this.expirationTime
                                )
                        );
                        if (missingQueries.length > 0) {
                            this.nextQueries.set(`${x},${y}`, { x, y, queries: missingQueries });
                            this.drainQueue();
                        }
                    });
            }
        }
    }

    drainQueue() {
        if (this.removed || this.error) return;
        while (this.currentQueries.size < 2 && this.nextQueries.size > 0) {
            const next = [...this.nextQueries.entries()].find(
                ([key]) => !this.currentQueries.has(key)
            );
            if (!next) break;
            const [key, tile] = next;
            this.nextQueries.delete(key);
            void this.queryTile(tile.x, tile.y, tile.queries);
        }
        this.updateStatus();
    }

    async queryTile(x: number, y: number, queries: string[]) {
        const generation = this.generation;
        const key = `${x},${y}`;
        this.currentQueries.add(key);
        const controller = new AbortController();
        this.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const bounds = mercator.bbox(x, y, this.queryZoom);
            const response = await fetch(
                `${this.overpassUrl}?${new URLSearchParams({ data: getQueryForBounds(bounds, queries) })}`,
                { signal: controller.signal, credentials: 'omit' }
            );
            if (!response.ok) throw new Error(`POI service returned ${response.status}`);
            const result = await response.json();
            if (!Array.isArray(result.elements) || result.remark) {
                throw new Error('POI service returned an incomplete response');
            }
            await this.storeOverpassData(x, y, queries, result);
        } catch {
            if (!this.removed && generation === this.generation) {
                this.error = 'Could not load points of interest. Please try again.';
                this.nextQueries.clear();
            }
        } finally {
            clearTimeout(timeout);
            this.controllers.delete(controller);
            this.currentQueries.delete(key);
            this.drainQueue();
            this.updateStatus();
        }
    }

    async storeOverpassData(x: number, y: number, queries: string[], data: any) {
        let time = Date.now();
        let queryTiles = queries.map((query) => ({ x, y, query: tileCacheKey(query), time }));
        let pois: { query: string; id: number; poi: GeoJSON.Feature }[] = [];

        if (data.elements === undefined) {
            return;
        }

        for (let element of data.elements) {
            for (let query of queries) {
                if (belongsToQuery(element, query)) {
                    pois.push({
                        query,
                        id: element.id,
                        poi: {
                            type: 'Feature',
                            geometry: {
                                type: 'Point',
                                coordinates: element.center
                                    ? [element.center.lon, element.center.lat]
                                    : [element.lon, element.lat],
                            },
                            properties: {
                                id: element.id,
                                lat: element.center ? element.center.lat : element.lat,
                                lon: element.center ? element.center.lon : element.lon,
                                query: query,
                                icon: `overpass-${query}`,
                                tags: element.tags,
                                type: element.type,
                            },
                        },
                    });
                }
            }
        }

        await db.transaction('rw', db.overpasstiles, db.overpassdata, async () => {
            await db.overpasstiles.bulkPut(queryTiles);
            await db.overpassdata.bulkPut(pois);
        });
    }

    loadIcons() {
        let currentQueries = getCurrentQueries();
        currentQueries.forEach((query) => {
            loadSVGIcon(
                this.map,
                `overpass-${query}`,
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
                    <circle cx="20" cy="20" r="20" fill="${overpassQueryData[query].icon.color}" />
                    <g transform="translate(8 8)">
                    ${overpassQueryData[query].icon.svg.replace('stroke="currentColor"', 'stroke="white"')}
                    </g>
                </svg>`
            );
        });
    }
}

function getQueryForBounds(bounds: [number, number, number, number], queries: string[]) {
    return `[timeout:20][bbox:${bounds[1]},${bounds[0]},${bounds[3]},${bounds[2]}][out:json];(${getQueries(queries)});out center;`;
}

function getQueries(queries: string[]) {
    return queries.map((query) => getQuery(query)).join('');
}

function getQuery(query: string) {
    if (Array.isArray(overpassQueryData[query].tags)) {
        return overpassQueryData[query].tags.map((tags) => getQueryItem(tags)).join('');
    } else {
        return getQueryItem(overpassQueryData[query].tags);
    }
}

function getQueryItem(tags: Record<string, string | string[]>) {
    let arrayEntry = Object.entries(tags).find((entry): entry is [string, string[]] =>
        Array.isArray(entry[1])
    );
    if (arrayEntry !== undefined) {
        return arrayEntry[1]
            .map(
                (val) =>
                    `nwr${Object.entries(tags)
                        .map(([tag, value]) => `[${tag}=${tag === arrayEntry[0] ? val : value}]`)
                        .join('')};`
            )
            .join('');
    } else {
        return `nwr${Object.entries(tags)
            .map(([tag, value]) => `[${tag}=${value}]`)
            .join('')};`;
    }
}

function belongsToQuery(element: any, query: string) {
    if (Array.isArray(overpassQueryData[query].tags)) {
        return overpassQueryData[query].tags.some((tags) => belongsToQueryItem(element, tags));
    } else {
        return belongsToQueryItem(element, overpassQueryData[query].tags);
    }
}

function belongsToQueryItem(element: any, tags: Record<string, string | string[]>) {
    if (!element.tags) return false;
    return Object.entries(tags).every(([tag, value]) =>
        Array.isArray(value) ? value.includes(element.tags[tag]) : element.tags[tag] === value
    );
}

function getCurrentQueries() {
    let currentQueries = get(currentOverpassQueries);
    if (currentQueries === undefined) {
        return [];
    }

    return Object.entries(getLayers(currentQueries))
        .filter(([_, selected]) => selected)
        .map(([query, _]) => query);
}

// Re-fetch Water tiles cached before support for all drinking_water=yes facilities.
function tileCacheKey(query: string) {
    return query === 'water' ? 'water-v2' : query;
}
