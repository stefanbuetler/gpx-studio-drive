// Fixed public upstreams; production proxies only routing and elevation requests.
export const serviceHosts = {
    graphhopper: 'https://graphhopper.gpx.studio',
    styles: 'https://styles.gpx.studio',
    tiles: 'https://tiles.gpx.studio',
};

export function serviceURL(url: string, development = import.meta.env.DEV): string {
    for (const [service, origin] of Object.entries(serviceHosts)) {
        if (url.startsWith(`${origin}/`)) {
            const upstreamPath = url.slice(origin.length);
            if (
                !development &&
                service !== 'graphhopper' &&
                !(service === 'tiles' && upstreamPath.startsWith('/mapterhorn/'))
            )
                return url;
            const path = `/__gpx_services/${service}${url.slice(origin.length)}`;
            return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
        }
    }
    return url;
}
