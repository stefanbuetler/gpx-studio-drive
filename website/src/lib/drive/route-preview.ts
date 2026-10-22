import { Map as PreviewMap, LngLatBounds, type StyleSpecification } from 'maplibre-gl';
import { map } from '$lib/components/map/map';
import { overlays, type CustomLayer } from '$lib/assets/layers';
import { serviceURL } from '$lib/service-url';
import { parseGPX } from 'gpx';

export type RoutePreview = { title: string; description: string; image: string };
function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        operation,
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Map preview timed out.')), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}
function waitFor(renderer: PreviewMap, event: 'load' | 'idle') {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            renderer.off(event, done);
            reject(new Error('Map timed out.'));
        }, 9000);
        function done() {
            clearTimeout(timer);
            resolve();
        }
        renderer.once(event, done);
    });
}
function text(
    ctx: CanvasRenderingContext2D,
    value: string,
    x: number,
    y: number,
    maxWidth: number
) {
    let fitted = value;
    while (fitted.length > 1 && ctx.measureText(fitted).width > maxWidth)
        fitted = fitted.slice(0, -1);
    ctx.fillText(fitted.length < value.length ? fitted.trimEnd() + '…' : fitted, x, y);
}
export async function createRoutePreview(
    gpx: File,
    name: string,
    view: Record<string, unknown>
): Promise<RoutePreview> {
    // Render the exact public saved GPX, independently of other open working copies.
    const file = parseGPX(await gpx.text());
    const title = name.replace(/\.gpx$/i, '').slice(0, 160) || 'Shared route';
    const stats = file.getStatistics().global;
    const imperial = view.distanceUnits === 'imperial';
    const nautical = view.distanceUnits === 'nautical';
    const distance = stats.distance.total * (imperial ? 0.621371 : nautical ? 0.539957 : 1);
    const gain = stats.elevation.gain * (imperial ? 3.28084 : 1);
    const description = `${distance.toFixed(1)} ${imperial ? 'mi' : nautical ? 'nm' : 'km'} · ${Math.round(gain)} ${imperial ? 'ft' : 'm'} ascent · View route on trail-explorer`;
    const points = file.getTrackPoints();
    if (!points.length) throw new Error('This route has no GPS points to preview.');
    const anchor = points[0].attributes.lon;
    const step = Math.max(1, Math.ceil(points.length / 12000));
    const segments = file.toGeoJSON().features.flatMap((feature) => {
        if (feature.geometry.type !== 'LineString') return [];
        const coordinates = feature.geometry.coordinates
            .filter((_, i, all) => i === 0 || i === all.length - 1 || i % step === 0)
            .filter(
                ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90
            )
            .map(
                ([lon, lat]) =>
                    [anchor + ((lon - anchor + 540) % 360) - 180, lat] as [number, number]
            );
        return coordinates.length ? [coordinates] : [];
    });
    if (!segments.length) throw new Error('This route has no valid track to preview.');
    const all = segments.flat();
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#eef2ee';
    ctx.fillRect(0, 0, 1200, 630);
    let attribution = '';
    const holder = document.createElement('div');
    Object.assign(holder.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '1200px',
        height: '500px',
        pointerEvents: 'none',
    });
    holder.setAttribute('aria-hidden', 'true');
    document.body.append(holder);
    let renderer: PreviewMap | undefined;
    try {
        const style = await deadline(
            map.previewStyle(String(view.basemap || 'openStreetMap')),
            8000
        );
        delete style.terrain;
        style.projection = { type: 'mercator' };
        const custom = (view.customLayers || {}) as Record<string, CustomLayer>;
        const opacity = (view.opacities || {}) as Record<string, number>;
        for (const [id, enabled] of Object.entries(
            (view.overlays || {}) as Record<string, boolean>
        )) {
            if (!enabled) continue;
            const info = custom[id]?.value || overlays[id];
            if (!info) continue;
            try {
                const overlay = structuredClone(
                    typeof info === 'string'
                        ? await deadline(
                              fetch(serviceURL(info)).then((r) => {
                                  if (!r.ok) throw new Error('Overlay unavailable');
                                  return r.json() as Promise<StyleSpecification>;
                              }),
                              4000
                          )
                        : info
                );
                Object.assign(style.sources, overlay.sources);
                const ids = new Set(style.layers.map((layer) => layer.id));
                for (const layer of overlay.layers || []) {
                    if (ids.has(layer.id)) continue;
                    if (layer.type === 'raster' && opacity[id] !== undefined)
                        layer.paint = { ...layer.paint, 'raster-opacity': opacity[id] };
                    style.layers.push(layer);
                }
            } catch {
                /* A failed optional overlay does not prevent a route preview. */
            }
        }
        const attributions = Object.values(style.sources).flatMap((source) =>
            source && 'attribution' in source && source.attribution ? [source.attribution] : []
        );
        attribution = [...new Set(attributions)]
            .map(
                (value) =>
                    new DOMParser().parseFromString(value, 'text/html').body.textContent || ''
            )
            .join(' · ');
        style.sources['shared-route-preview'] = {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: segments
                    .filter((s) => s.length > 1)
                    .map((coordinates) => ({
                        type: 'Feature',
                        properties: {},
                        geometry: { type: 'LineString', coordinates },
                    })),
            },
        };
        style.sources['shared-route-ends'] = {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: [all[0], all[all.length - 1]].map((coordinates, i) => ({
                    type: 'Feature',
                    properties: { color: i ? '#e34b39' : '#15803d' },
                    geometry: { type: 'Point', coordinates },
                })),
            },
        };
        style.layers.push(
            {
                id: 'shared-route-halo',
                type: 'line',
                source: 'shared-route-preview',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#ffffff', 'line-width': 9 },
            },
            {
                id: 'shared-route-line',
                type: 'line',
                source: 'shared-route-preview',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#4f46e5', 'line-width': 5 },
            },
            {
                id: 'shared-route-markers',
                type: 'circle',
                source: 'shared-route-ends',
                paint: {
                    'circle-radius': 6,
                    'circle-color': ['get', 'color'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 3,
                },
            }
        );
        renderer = new PreviewMap({
            container: holder,
            style,
            interactive: false,
            attributionControl: false,
            pixelRatio: 1,
            canvasContextAttributes: { preserveDrawingBuffer: true },
            transformRequest: (url) => ({ url: serviceURL(url) }),
        });
        await waitFor(renderer, 'load');
        const bounds = new LngLatBounds();
        all.forEach((coord) => bounds.extend(coord));
        renderer.fitBounds(bounds, {
            padding: 55,
            maxZoom: 15,
            duration: 0,
            bearing: Number(view.bearing) || 0,
        });
        await waitFor(renderer, 'idle');
        ctx.drawImage(renderer.getCanvas(), 0, 0, 1200, 500);
        attribution = `MapLibre · ${attribution || '© OpenStreetMap contributors'}`;
    } catch {
        // Offline/custom-tile failures still yield a real outline of this route.
        attribution = 'Route overview';
        ctx.fillStyle = '#eef2ee';
        ctx.fillRect(0, 0, 1200, 500);
        const projected = segments.map((segment) =>
            segment.map(([lon, lat]) => [
                lon,
                (-Math.log(
                    Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)
                ) *
                    180) /
                    Math.PI,
            ])
        );
        const flat = projected.flat();
        const minX = Math.min(...flat.map((p) => p[0])),
            maxX = Math.max(...flat.map((p) => p[0]));
        const minY = Math.min(...flat.map((p) => p[1])),
            maxY = Math.max(...flat.map((p) => p[1]));
        const scale = Math.min(
            1080 / Math.max(maxX - minX, 0.0001),
            380 / Math.max(maxY - minY, 0.0001)
        );
        const point = (p: number[]) => [
            600 + (p[0] - (minX + maxX) / 2) * scale,
            250 + (p[1] - (minY + maxY) / 2) * scale,
        ];
        ctx.strokeStyle = '#dce3dd';
        ctx.lineWidth = 1;
        for (let x = 0; x < 1200; x += 60) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 500);
            ctx.stroke();
        }
        for (let y = 0; y < 500; y += 60) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(1200, y);
            ctx.stroke();
        }
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const segment of projected) {
            ctx.beginPath();
            segment.forEach((p, i) => {
                const [x, y] = point(p);
                if (i) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
            });
            ctx.stroke();
        }
        [flat[0], flat[flat.length - 1]].forEach((p, i) => {
            const [x, y] = point(p);
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.fillStyle = i ? '#e34b39' : '#15803d';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            ctx.stroke();
        });
    } finally {
        renderer?.remove();
        holder.remove();
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 500, 1200, 130);
    ctx.fillStyle = '#171717';
    ctx.font = 'bold 32px Arial,sans-serif';
    text(ctx, title, 32, 543, 1136);
    ctx.fillStyle = '#555555';
    ctx.font = '22px Arial,sans-serif';
    text(ctx, description, 32, 581, 1136);
    ctx.fillStyle = '#666666';
    ctx.font = '12px Arial,sans-serif';
    text(ctx, attribution, 32, 613, 1136);
    let image = canvas.toDataURL('image/jpeg', 0.84);
    if (image.length > 740000) image = canvas.toDataURL('image/jpeg', 0.6);
    if (image.length > 740000) image = canvas.toDataURL('image/jpeg', 0.4);
    if (image.length > 740000) throw new Error('Could not create a compact route image.');
    return { title, description, image };
}
