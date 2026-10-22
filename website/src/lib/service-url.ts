// Only these public upstream services can be reached through the local dev server.
export const serviceHosts = {
    graphhopper: 'https://graphhopper.gpx.studio',
    styles: 'https://styles.gpx.studio',
    tiles: 'https://tiles.gpx.studio',
};

export function serviceURL(url: string): string {
    if (!import.meta.env.DEV) return url;
    for (const [service, origin] of Object.entries(serviceHosts)) {
        if (url.startsWith(`${origin}/`)) {
            const path = `/__gpx_services/${service}${url.slice(origin.length)}`;
            return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
        }
    }
    return url;
}
