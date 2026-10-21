// Browser-only Google Drive API integration. Tokens are kept in memory.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';

type TokenResponse = { access_token?: string; error?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type GoogleIdentity = { accounts: { oauth2: { initTokenClient: (options: {
    client_id: string; scope: string; callback: (response: TokenResponse) => void;
}) => TokenClient; revoke: (token: string, callback: () => void) => void } } };

declare global {
    interface Window { google?: GoogleIdentity }
}

export type DriveGPXFile = { id: string; name: string; modifiedTime?: string };

function loadIdentity(): Promise<void> {
    if (window.google?.accounts.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity]');
        if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error('Google sign-in unavailable')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.dataset.googleIdentity = 'true';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Google sign-in unavailable'));
        document.head.appendChild(script);
    });
}

export class DriveClient {
    private token: string | null = null;
    constructor(private clientId: string) {}

    get connected() { return this.token !== null; }

    async connect(): Promise<void> {
        if (!this.clientId) throw new Error('PUBLIC_GOOGLE_CLIENT_ID is not configured');
        await loadIdentity();
        return new Promise<void>((resolve, reject) => {
            const oauth = window.google!.accounts.oauth2;
            const client = oauth.initTokenClient({
                client_id: this.clientId,
                scope: DRIVE_SCOPE,
                callback: (response) => {
                    if (response.error || !response.access_token) {
                        reject(new Error(response.error || 'Google sign-in was cancelled'));
                    } else {
                        this.token = response.access_token;
                        resolve();
                    }
                },
            });
            client.requestAccessToken({ prompt: 'consent' });
        });
    }

    disconnect() {
        const oldToken = this.token;
        this.token = null;
        if (oldToken && window.google?.accounts.oauth2) {
            window.google.accounts.oauth2.revoke(oldToken, () => {});
        }
    }

    private async request(url: string, init: RequestInit = {}): Promise<Response> {
        if (!this.token) throw new Error('Connect Google Drive first');
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${this.token}`);
        const response = await fetch(url, { ...init, headers });
        if (response.status === 401) {
            this.token = null;
            throw new Error('Google session expired. Connect again.');
        }
        if (!response.ok) throw new Error(`Google Drive error (${response.status}): ${(await response.text()).slice(0, 250)}`);
        return response;
    }

    async listGPX(): Promise<DriveGPXFile[]> {
        const files: DriveGPXFile[] = [];
        let pageToken: string | undefined;
        do {
            const params = new URLSearchParams({
                q: "trashed = false and (mimeType = 'application/gpx+xml' or mimeType = 'application/octet-stream' or name contains '.gpx')",
                fields: 'nextPageToken,files(id,name,modifiedTime)',
                pageSize: '1000',
                orderBy: 'modifiedTime desc',
            });
            if (pageToken) params.set('pageToken', pageToken);
            const response = await this.request(`${API}?${params}`);
            const data = await response.json() as { files?: DriveGPXFile[]; nextPageToken?: string };
            files.push(...(data.files ?? []).filter(f => f.name.toLowerCase().endsWith('.gpx')));
            pageToken = data.nextPageToken;
        } while (pageToken);
        return files;
    }

    async getMetadata(fileId: string): Promise<DriveGPXFile> {
        const response = await this.request(`${API}/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime`);
        return await response.json() as DriveGPXFile;
    }

    async update(file: DriveGPXFile, gpx: string): Promise<DriveGPXFile> {
        const remote = await this.getMetadata(file.id);
        if (file.modifiedTime && remote.modifiedTime !== file.modifiedTime) {
            throw new Error('Conflict: this GPX was modified in Google Drive. Refresh and review changes before saving.');
        }
        const doc = new DOMParser().parseFromString(gpx, 'application/xml');
        if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') {
            throw new Error('Cannot save invalid GPX XML');
        }
        if (new Blob([gpx]).size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
        const response = await this.request(
            `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id,name,modifiedTime`,
            { method: 'PATCH', headers: { 'Content-Type': 'application/gpx+xml' }, body: gpx }
        );
        return await response.json() as DriveGPXFile;
    }

    async download(file: DriveGPXFile): Promise<File> {
        const response = await this.request(`${API}/${encodeURIComponent(file.id)}?alt=media`);
        const content = await response.blob();
        if (content.size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
        return new File([content], file.name, { type: 'application/gpx+xml' });
    }

    async upload(file: File): Promise<DriveGPXFile> {
        if (!file.name.toLowerCase().endsWith('.gpx')) throw new Error('Choose a .gpx file');
        if (file.size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
        const text = await file.text();
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') {
            throw new Error('Invalid GPX XML file');
        }
        const metadata = { name: file.name, mimeType: 'application/gpx+xml' };
        const boundary = 'gpxstudio_' + crypto.randomUUID();
        const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
            JSON.stringify(metadata),
            `\r\n--${boundary}\r\nContent-Type: application/gpx+xml\r\n\r\n`,
            text,
            `\r\n--${boundary}--`,
        ]);
        const response = await this.request(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime',
            { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
        );
        return await response.json() as DriveGPXFile;
    }
}
