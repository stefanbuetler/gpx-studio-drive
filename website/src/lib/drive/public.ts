import type { DriveGPXFile } from './client';

export function publicDriveURL(fileId: string, resourceKey?: string): string {
    const key = import.meta.env.PUBLIC_GOOGLE_API_KEY;
    if (!key)
        throw new Error(
            'Public viewing is not configured. Set PUBLIC_GOOGLE_API_KEY for this app.'
        );
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('key', key);
    if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
    return url.href;
}

export function publicViewerURL(file: DriveGPXFile, view?: unknown): string {
    // Check configuration before changing any file permissions.
    publicDriveURL(file.id, file.resourceKey);
    const configured = import.meta.env.PUBLIC_APP_URL || window.location.origin;
    const url = new URL(configured);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
        throw new Error(
            'Set PUBLIC_APP_URL to your public HTTPS app address before sharing. A localhost link cannot be opened by other people.'
        );
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/share`;
    url.search = '';
    url.hash = '';
    url.searchParams.set('id', file.id);
    if (file.resourceKey) url.searchParams.set('resourcekey', file.resourceKey);
    if (view) url.searchParams.set('view', JSON.stringify(view));
    return url.href;
}

export async function downloadPublicGPX(source: string): Promise<File> {
    const url = new URL(source, window.location.href);
    const headers = new Headers();
    if (url.origin === 'https://www.googleapis.com') {
        const fileId = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)?.[1];
        const resourceKey = url.searchParams.get('resourcekey');
        if (fileId && resourceKey)
            headers.set(
                'X-Goog-Drive-Resource-Keys',
                `${decodeURIComponent(fileId)}/${resourceKey}`
            );
        url.searchParams.delete('resourcekey');
    }
    const response = await fetch(url, { headers, credentials: 'omit' });
    if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
            throw new Error(
                'This route is not publicly available. Ask its owner to check link sharing, or try again later.'
            );
        }
        throw new Error(`Could not load this route (${response.status}). Try again later.`);
    }
    if (Number(response.headers.get('Content-Length')) > 30 * 1024 * 1024)
        throw new Error('GPX exceeds 30 MB limit');
    const blob = await response.blob();
    if (blob.size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
    const xml = await blob.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx')
        throw new Error('The shared file is not a valid GPX route.');
    return new File([blob], `${decodeURIComponent(url.pathname.split('/').pop() || 'route')}.gpx`, {
        type: 'application/gpx+xml',
    });
}
