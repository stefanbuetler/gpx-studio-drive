import { publicDriveURL } from '$lib/drive/public';
import { PUBLIC_MAPTILER_KEY } from '$env/static/public';
import { type LayerTreeType, type CustomLayer, basemaps } from '$lib/assets/layers';

export type EmbeddingOptions = {
    key: string;
    files: string[];
    ids: string[];
    resourceKeys?: Record<string, string>;
    basemap: string;
    overlays: LayerTreeType;
    overpassQueries: LayerTreeType;
    opacities: Record<string, number>;
    customLayers: Record<string, CustomLayer>;
    terrainSource: 'mapterhorn';
    defaultWidth: number;
    defaultOpacity: number;
    pitch: number;
    bearing: number;
    elevation: {
        show: boolean;
        height: number;
        controls: boolean;
        fill: 'slope' | 'surface' | 'highway' | 'none';
        speed: boolean;
        hr: boolean;
        cad: boolean;
        temp: boolean;
        power: boolean;
    };
    distanceMarkers: boolean;
    directionMarkers: boolean;
    distanceUnits: 'metric' | 'imperial' | 'nautical';
    velocityUnits: 'speed' | 'pace';
    temperatureUnits: 'celsius' | 'fahrenheit';
    theme: 'system' | 'light' | 'dark';
};

export const defaultEmbeddingOptions = {
    key: '',
    files: [],
    ids: [],
    resourceKeys: {},
    basemap: 'libertyTopo',
    overlays: {},
    overpassQueries: {},
    opacities: {},
    customLayers: {},
    terrainSource: 'mapterhorn',
    defaultWidth: 5,
    defaultOpacity: 0.7,
    pitch: 0,
    bearing: 0,
    elevation: {
        show: true,
        height: 170,
        controls: true,
        fill: 'none',
        speed: false,
        hr: false,
        cad: false,
        temp: false,
        power: false,
    },
    distanceMarkers: false,
    directionMarkers: false,
    distanceUnits: 'metric',
    velocityUnits: 'speed',
    temperatureUnits: 'celsius',
    theme: 'system',
};

export function getMergedEmbeddingOptions(
    options: any,
    defaultOptions: any = defaultEmbeddingOptions
): EmbeddingOptions {
    const mergedOptions = JSON.parse(JSON.stringify(defaultOptions ?? {}));
    for (const key of Object.keys(options ?? {})) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        if (
            typeof options[key] === 'object' &&
            options[key] !== null &&
            !Array.isArray(options[key])
        ) {
            mergedOptions[key] = getMergedEmbeddingOptions(
                options[key],
                defaultOptions?.[key] ?? {}
            );
        } else {
            mergedOptions[key] = options[key];
        }
    }
    return mergedOptions;
}

export function getCleanedEmbeddingOptions(
    options: any,
    defaultOptions: any = defaultEmbeddingOptions
): any {
    const cleanedOptions = JSON.parse(JSON.stringify(options));
    for (const key in cleanedOptions) {
        if (
            typeof cleanedOptions[key] === 'object' &&
            cleanedOptions[key] !== null &&
            !Array.isArray(cleanedOptions[key])
        ) {
            cleanedOptions[key] = getCleanedEmbeddingOptions(
                cleanedOptions[key],
                defaultOptions?.[key] ?? {}
            );
            if (Object.keys(cleanedOptions[key]).length === 0) {
                delete cleanedOptions[key];
            }
        } else if (JSON.stringify(cleanedOptions[key]) === JSON.stringify(defaultOptions?.[key])) {
            delete cleanedOptions[key];
        }
    }
    if (cleanedOptions['key'] && cleanedOptions['key'] === PUBLIC_MAPTILER_KEY) {
        delete cleanedOptions['key'];
    }
    return cleanedOptions;
}

export const allowedEmbeddingBasemaps = Object.keys(basemaps).filter(
    (basemap) => !['ordnanceSurvey'].includes(basemap)
);

export function getFilesFromEmbeddingOptions(options: EmbeddingOptions): string[] {
    return options.files.concat(
        options.ids.map((id) => getURLForGoogleDriveFile(id, options.resourceKeys?.[id]))
    );
}

export function getURLForGoogleDriveFile(fileId: string, resourceKey?: string): string {
    return publicDriveURL(fileId, resourceKey);
}

export function convertOldEmbeddingOptions(options: URLSearchParams): any {
    let newOptions: any = {
        key: PUBLIC_MAPTILER_KEY,
        files: [],
        ids: [],
    };
    if (options.has('state')) {
        let state = JSON.parse(options.get('state')!);
        if (state.ids) {
            newOptions.ids.push(...state.ids);
        }
        if (state.urls) {
            newOptions.files.push(...state.urls);
        }
    }
    if (options.has('source')) {
        let basemap = options.get('source')!;
        if (basemap === 'satellite') {
            newOptions.basemap = 'libertySatellite';
        } else if (basemap === 'otm') {
            newOptions.basemap = 'openTopoMap';
        } else if (basemap === 'ohm') {
            newOptions.basemap = 'openHikingMap';
        }
    }
    if (options.has('imperial')) {
        newOptions.distanceUnits = 'imperial';
    }
    if (options.has('running')) {
        newOptions.velocityUnits = 'pace';
    }
    if (options.has('distance')) {
        newOptions.distanceMarkers = true;
    }
    if (options.has('direction')) {
        newOptions.directionMarkers = true;
    }
    if (options.has('slope')) {
        newOptions.elevation = {
            fill: 'slope',
        };
    }
    return newOptions;
}
