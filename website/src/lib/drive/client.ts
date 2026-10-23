import { driveAccount } from './browser';
// Access tokens stay in memory. Persistent sessions use the same-origin session service.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_FIELDS =
    'id,name,mimeType,modifiedTime,resourceKey,isAppAuthorized,trashed,parents,appProperties,capabilities(canEdit,canShare,canAddChildren)';
const API = 'https://www.googleapis.com/drive/v3/files';

type TokenResponse = { access_token?: string; error?: string; expires_in?: number; scope?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type GoogleIdentity = {
    accounts: {
        oauth2: {
            initTokenClient: (options: {
                client_id: string;
                scope: string;
                callback: (response: TokenResponse) => void;
                error_callback: (error: { type: string }) => void;
            }) => TokenClient;
            initCodeClient?: (options: {
                client_id: string;
                scope: string;
                ux_mode: 'popup';
                callback: (response: { code?: string; error?: string }) => void;
                error_callback: (error: { type: string }) => void;
            }) => { requestCode: () => void };
            revoke: (token: string, callback: () => void) => void;
        };
    };
};

declare global {
    interface Window {
        google?: GoogleIdentity;
    }
}

export type DriveGPXFile = {
    id: string;
    name: string;
    modifiedTime?: string;
    resourceKey?: string;
    mimeType?: string;
    isAppAuthorized?: boolean;
    trashed?: boolean;
    parents?: string[];
    appProperties?: Record<string, string>;
    capabilities?: { canEdit?: boolean; canShare?: boolean; canAddChildren?: boolean };
};

export type DriveIndex = {
    files: DriveGPXFile[];
    tokens: Record<string, string>;
    updatedAt: number;
};
export class DriveIndexReset extends Error {}

let identityPromise: Promise<void> | undefined;

function loadIdentity(): Promise<void> {
    if (typeof window === 'undefined')
        return Promise.reject(new Error('Google sign-in requires a browser'));
    if (window.google?.accounts.oauth2) return Promise.resolve();
    if (identityPromise) return identityPromise;
    identityPromise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => fail(), 15000);
        function fail() {
            clearTimeout(timer);
            script.remove();
            reject(new Error('Google sign-in unavailable. Check your connection and try again.'));
        }
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.dataset.googleIdentity = 'true';
        script.onload = () => {
            if (!window.google?.accounts.oauth2) {
                fail();
                return;
            }
            clearTimeout(timer);
            resolve();
        };
        script.onerror = fail;
        document.head.appendChild(script);
    }).catch((error) => {
        identityPromise = undefined;
        throw error;
    });
    return identityPromise;
}

const MAX_SIZE = 30 * 1024 * 1024;
function validateGPX(content: string) {
    if (new Blob([content]).size > MAX_SIZE) throw new Error('GPX exceeds 30 MB limit');
    const doc = new DOMParser().parseFromString(content, 'application/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') {
        throw new Error('Invalid GPX XML file');
    }
}

export class DriveClient {
    private token: string | null = null;
    private expiresAt = 0;
    private persistent = false;
    private scopes = new Set<string>();
    private configPromise?: Promise<{ persistent: boolean; clientId?: string }>;
    private renewal?: Promise<boolean>;
    constructor(private clientId: string) {}

    private configuration() {
        return (this.configPromise ??= fetch('/api/drive/config', {
            cache: 'no-store',
            credentials: 'same-origin',
        })
            .then(async (response) => {
                if (response.status === 404) return { persistent: false };
                if (!response.ok)
                    throw new Error('Google connection service is unavailable. Try again.');
                return (await response.json()) as { persistent: boolean; clientId?: string };
            })
            .catch((error) => {
                this.configPromise = undefined;
                throw error;
            }));
    }

    private async sessionRequest(path: string, body?: object) {
        return fetch(`/api/drive/${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-GPX-Drive-Request': '1' },
            body: JSON.stringify(body ?? {}),
        });
    }

    private acceptToken(response: TokenResponse) {
        if (
            !response.access_token ||
            (response.scope && !response.scope.split(' ').includes(DRIVE_SCOPE))
        )
            throw new Error('GDrive permission was not granted');
        this.scopes = new Set((response.scope || DRIVE_SCOPE).split(' '));
        this.token = response.access_token;
        this.expiresAt = Date.now() + Math.max(1, response.expires_in ?? 3600) * 1000;
    }

    async restore(): Promise<boolean> {
        if (!(await this.configuration()).persistent) return false;
        if (!this.renewal)
            this.renewal = this.renewSession().finally(() => {
                this.renewal = undefined;
            });
        return this.renewal;
    }

    private async renewSession() {
        const response = await this.sessionRequest('session');
        if (response.status === 401) {
            this.token = null;
            this.persistent = false;
            return false;
        }
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error || 'Could not restore Google sign-in. Try again.');
        this.acceptToken(data);
        this.persistent = true;
        return true;
    }

    get connected() {
        return this.persistent || (this.token !== null && Date.now() < this.expiresAt);
    }

    prepare() {
        return Promise.all([loadIdentity(), this.configuration()]);
    }

    get searchesAllDrive() {
        return this.scopes.has(READ_SCOPE);
    }

    canEdit(file: DriveGPXFile) {
        return (
            (!this.searchesAllDrive || file.isAppAuthorized === true) &&
            file.capabilities?.canEdit !== false
        );
    }

    canShare(file: DriveGPXFile) {
        return (
            (!this.searchesAllDrive || file.isAppAuthorized === true) &&
            file.capabilities?.canShare !== false
        );
    }

    async connect(allDrive = false): Promise<void> {
        const requestedScope = allDrive ? `${DRIVE_SCOPE} ${READ_SCOPE}` : DRIVE_SCOPE;
        if (!this.clientId) throw new Error('PUBLIC_GOOGLE_CLIENT_ID is not configured');
        // Preload on mount so the popup opens directly from the user's click.
        if (!window.google?.accounts.oauth2) await this.prepare();
        const config = await this.configuration();
        if (config.persistent) {
            return new Promise<void>((resolve, reject) => {
                const oauth = window.google!.accounts.oauth2;
                if (!oauth.initCodeClient)
                    return reject(
                        new Error('Google sign-in is unavailable. Reload and try again.')
                    );
                const client = oauth.initCodeClient({
                    client_id: config.clientId || this.clientId,
                    scope: requestedScope,
                    ux_mode: 'popup',
                    error_callback: (error) =>
                        reject(
                            new Error(
                                error.type === 'popup_closed'
                                    ? 'Google sign-in was cancelled'
                                    : 'Could not open Google sign-in. Allow popups and try again.'
                            )
                        ),
                    callback: (result) => {
                        if (!result.code || result.error) {
                            reject(new Error(result.error || 'Google sign-in was cancelled'));
                            return;
                        }
                        void this.sessionRequest('connect', { code: result.code })
                            .then(async (response) => {
                                const data = await response.json();
                                if (!response.ok)
                                    throw new Error(data.error || 'Could not connect GDrive.');
                                this.acceptToken(data);
                                this.persistent = true;
                                resolve();
                            })
                            .catch(reject);
                    },
                });
                client.requestCode();
            });
        }
        return new Promise<void>((resolve, reject) => {
            const oauth = window.google!.accounts.oauth2;
            const client = oauth.initTokenClient({
                client_id: this.clientId,
                scope: requestedScope,
                error_callback: (error) =>
                    reject(
                        new Error(
                            error.type === 'popup_closed'
                                ? 'Google sign-in was cancelled'
                                : 'Could not open Google sign-in. Allow popups and try again.'
                        )
                    ),
                callback: (response) => {
                    if (
                        response.error ||
                        !response.access_token ||
                        (response.scope && !response.scope.split(' ').includes(DRIVE_SCOPE))
                    ) {
                        reject(new Error(response.error || 'GDrive permission was not granted'));
                    } else {
                        this.acceptToken(response);
                        resolve();
                    }
                },
            });
            client.requestAccessToken({ prompt: '' });
        });
    }

    async disconnect() {
        driveAccount.set(null);
        const oldToken = this.token;
        const wasPersistent = this.persistent;
        this.token = null;
        this.persistent = false;
        this.expiresAt = 0;
        if (wasPersistent) {
            const response = await this.sessionRequest('disconnect');
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Could not confirm Google disconnect. Try again.');
            }
        } else if (oldToken && window.google?.accounts.oauth2) {
            window.google.accounts.oauth2.revoke(oldToken, () => {});
        }
    }

    private async request(url: string, init: RequestInit = {}): Promise<Response> {
        if (this.persistent && Date.now() >= this.expiresAt - 30000) await this.restore();
        if (!this.connected || !this.token) {
            this.token = null;
            throw new Error('Google session expired. Sign in with Google again.');
        }
        const send = () =>
            fetch(url, {
                ...init,
                headers: new Headers({
                    ...Object.fromEntries(new Headers(init.headers)),
                    Authorization: `Bearer ${this.token}`,
                }),
            });
        let response = await send();
        if (response.status === 401 && this.persistent && (await this.restore()))
            response = await send();
        if (response.status === 401) {
            this.token = null;
            this.persistent = false;
            driveAccount.set(null);
            throw new Error('Google session expired. Sign in again.');
        }
        if (response.status === 412)
            throw new Error(
                'Conflict: this GPX changed in GDrive. Reopen it as a new local copy to review changes.'
            );
        if (!response.ok)
            throw new Error(
                `GDrive error (${response.status}): ${(await response.text()).slice(0, 250)}`
            );
        return response;
    }

    async listGPX(
        onProgress?: (scanned: number) => void,
        beforeSharedDrive?: (driveId: string) => Promise<void>
    ): Promise<DriveGPXFile[]> {
        const files = new Map<string, DriveGPXFile>();
        let scanned = 0;
        const list = async (driveId?: string) => {
            let pageToken: string | undefined;
            const seen = new Set<string>();
            do {
                const params = new URLSearchParams({
                    // Drive's name-contains operator only matches prefixes. Scan metadata
                    // so suffixes such as .gPx and files uploaded as XML are not missed.
                    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut'",
                    fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
                    pageSize: '1000',
                    orderBy: 'modifiedTime desc',
                    supportsAllDrives: 'true',
                    includeItemsFromAllDrives: 'true',
                    corpora: driveId ? 'drive' : 'user',
                });
                if (driveId) params.set('driveId', driveId);
                if (pageToken) params.set('pageToken', pageToken);
                const response = await this.request(`${API}?${params}`);
                const data = (await response.json()) as {
                    files?: DriveGPXFile[];
                    nextPageToken?: string;
                    incompleteSearch?: boolean;
                };
                if (data.incompleteSearch)
                    throw new Error(
                        'Google returned an incomplete GDrive search. Refresh to try again.'
                    );
                scanned += data.files?.length ?? 0;
                for (const file of data.files ?? []) {
                    if (
                        file.name.toLowerCase().endsWith('.gpx') ||
                        file.mimeType?.toLowerCase() === 'application/gpx+xml'
                    )
                        files.set(file.id, file);
                }
                onProgress?.(scanned);
                pageToken = data.nextPageToken;
                if (pageToken && seen.has(pageToken))
                    throw new Error('Google repeated a search page. Refresh to try again.');
                if (pageToken) seen.add(pageToken);
            } while (pageToken);
        };
        await list();
        if (this.searchesAllDrive)
            for (const driveId of await this.sharedDriveIds()) {
                await beforeSharedDrive?.(driveId);
                await list(driveId);
            }
        return [...files.values()].sort((a, b) =>
            (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '')
        );
    }

    private async sharedDriveIds(): Promise<string[]> {
        const ids = new Set<string>();
        let pageToken: string | undefined;
        const seen = new Set<string>();
        do {
            const params = new URLSearchParams({
                pageSize: '100',
                fields: 'nextPageToken,drives(id)',
            });
            if (pageToken) params.set('pageToken', pageToken);
            const response = await this.request(
                `https://www.googleapis.com/drive/v3/drives?${params}`
            );
            const data = (await response.json()) as {
                drives?: { id: string }[];
                nextPageToken?: string;
            };
            for (const drive of data.drives ?? []) ids.add(drive.id);
            pageToken = data.nextPageToken;
            if (pageToken && seen.has(pageToken))
                throw new Error('Google repeated a shared-drive page. Refresh to try again.');
            if (pageToken) seen.add(pageToken);
        } while (pageToken);
        return [...ids];
    }

    async accountKey(): Promise<string> {
        const response = await this.request(
            'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress)'
        );
        const data = await response.json();
        const id = data.user?.permissionId;
        driveAccount.set({
            displayName:
                typeof data.user?.displayName === 'string' ? data.user.displayName : undefined,
            emailAddress:
                typeof data.user?.emailAddress === 'string' ? data.user.emailAddress : undefined,
        });
        if (typeof id !== 'string' || !id)
            throw new Error('Could not identify the connected GDrive account.');
        const config = await this.configuration();
        return `${config.clientId || this.clientId}:${id}`;
    }

    async indexKey(): Promise<string> {
        return `${await this.accountKey()}:${this.searchesAllDrive ? 'all' : 'app'}`;
    }

    private async startChangeToken(driveId?: string): Promise<string> {
        const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'startPageToken' });
        if (driveId) params.set('driveId', driveId);
        const response = await this.request(
            `https://www.googleapis.com/drive/v3/changes/startPageToken?${params}`
        );
        const data = await response.json();
        if (typeof data.startPageToken !== 'string' || !data.startPageToken)
            throw new Error('Could not start the GDrive index.');
        return data.startPageToken;
    }

    async buildIndex(onProgress?: (scanned: number) => void): Promise<DriveIndex> {
        // Capture cursors before scanning so changes during the scan are replayed later.
        const tokens: Record<string, string> = { user: await this.startChangeToken() };
        const files = await this.listGPX(onProgress, async (id) => {
            tokens[id] = await this.startChangeToken(id);
        });
        return { files, tokens, updatedAt: Date.now() };
    }

    async syncIndex(index: DriveIndex): Promise<DriveIndex> {
        const drives = this.searchesAllDrive ? await this.sharedDriveIds() : [];
        if (
            JSON.stringify(drives.sort()) !==
            JSON.stringify(
                Object.keys(index.tokens)
                    .filter((id) => id !== 'user')
                    .sort()
            )
        ) {
            throw new DriveIndexReset('Shared drive membership changed');
        }
        const files = new Map(index.files.map((file) => [file.id, file]));
        const tokens = { ...index.tokens };
        for (const [id, token] of Object.entries(index.tokens)) {
            let pageToken: string | undefined = token;
            const seen = new Set<string>();
            while (pageToken) {
                if (seen.has(pageToken))
                    throw new Error('Google repeated a change page. Refresh to try again.');
                seen.add(pageToken);
                const params = new URLSearchParams({
                    pageToken,
                    pageSize: '1000',
                    supportsAllDrives: 'true',
                    includeItemsFromAllDrives: 'true',
                    includeRemoved: 'true',
                    fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
                });
                if (id !== 'user') params.set('driveId', id);
                let response: Response;
                try {
                    response = await this.request(
                        `https://www.googleapis.com/drive/v3/changes?${params}`
                    );
                } catch (error) {
                    if (error instanceof Error && error.message.includes('GDrive error (410)'))
                        throw new DriveIndexReset('Drive change cursor was rejected');
                    throw error;
                }
                const data = await response.json();
                for (const change of data.changes ?? []) {
                    if (!change.fileId) continue;
                    const file = change.file as DriveGPXFile | undefined;
                    if (
                        change.removed ||
                        !file ||
                        file.trashed ||
                        file.mimeType?.startsWith('application/vnd.google-apps.') ||
                        !(
                            file.name?.toLowerCase().endsWith('.gpx') ||
                            file.mimeType === 'application/gpx+xml'
                        )
                    )
                        files.delete(change.fileId);
                    else files.set(change.fileId, file);
                }
                pageToken = data.nextPageToken;
                if (!pageToken) {
                    if (typeof data.newStartPageToken !== 'string' || !data.newStartPageToken)
                        throw new Error(
                            'Google did not return a complete change cursor. Refresh to try again.'
                        );
                    tokens[id] = data.newStartPageToken;
                }
            }
        }
        return {
            files: [...files.values()].sort((a, b) =>
                (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '')
            ),
            tokens,
            updatedAt: Date.now(),
        };
    }

    private resourceHeaders(fileId: string, resourceKey?: string): HeadersInit {
        return resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` } : {};
    }

    async getMetadata(fileId: string, resourceKey?: string): Promise<DriveGPXFile> {
        const response = await this.request(
            `${API}/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
            { headers: this.resourceHeaders(fileId, resourceKey) }
        );
        const file = (await response.json()) as DriveGPXFile;
        return { ...file, resourceKey: file.resourceKey ?? resourceKey };
    }

    async makePublic(file: DriveGPXFile): Promise<DriveGPXFile> {
        if (!this.canShare(file))
            throw new Error('This file is read-only for this app. Upload a copy to share it.');
        let pageToken: string | undefined;
        let alreadyPublic = false;
        do {
            const params = new URLSearchParams({
                fields: 'nextPageToken,permissions(id,type,role)',
                pageSize: '100',
                supportsAllDrives: 'true',
            });
            if (pageToken) params.set('pageToken', pageToken);
            const response = await this.request(
                `${API}/${encodeURIComponent(file.id)}/permissions?${params}`
            );
            const data = (await response.json()) as {
                permissions?: { type: string; role: string }[];
                nextPageToken?: string;
            };
            for (const permission of data.permissions ?? []) {
                if (permission.type !== 'anyone') continue;
                if (permission.role !== 'reader')
                    throw new Error(
                        'This file already allows public editing or commenting. Change its GDrive sharing to Viewer before creating a view-only link.'
                    );
                alreadyPublic = true;
            }
            pageToken = data.nextPageToken;
        } while (pageToken);
        if (!alreadyPublic) {
            await this.request(
                `${API}/${encodeURIComponent(file.id)}/permissions?supportsAllDrives=true&fields=id`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'anyone',
                        role: 'reader',
                        allowFileDiscovery: false,
                    }),
                }
            );
        }
        const response = await this.request(
            `${API}/${encodeURIComponent(file.id)}?fields=${FILE_FIELDS}&supportsAllDrives=true`
        );
        return (await response.json()) as DriveGPXFile;
    }

    async update(file: DriveGPXFile, gpx: string, filename?: string): Promise<DriveGPXFile> {
        if (!this.canEdit(file))
            throw new Error(
                'This file is read-only for this app. Export your edits or upload a copy instead.'
            );
        validateGPX(gpx);
        const metadata = await this.request(
            `${API}/${encodeURIComponent(file.id)}?fields=id,name,modifiedTime&supportsAllDrives=true`
        );
        const remote = (await metadata.json()) as DriveGPXFile;
        if (!file.modifiedTime || remote.modifiedTime !== file.modifiedTime) {
            throw new Error(
                'Conflict: this GPX was modified in GDrive. Reopen the saved GDrive file to review changes, or save a separate local copy.'
            );
        }
        const headers = new Headers({ 'Content-Type': 'application/gpx+xml' });
        const etag = metadata.headers.get('ETag');
        if (etag) headers.set('If-Match', etag);
        let body: BodyInit = gpx;
        let uploadType = 'media';
        if (filename && filename !== file.name) {
            uploadType = 'multipart';
            const boundary = 'trail_explorer_' + crypto.randomUUID();
            headers.set('Content-Type', `multipart/related; boundary=${boundary}`);
            body = new Blob([
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
                JSON.stringify({ name: filename }),
                `\r\n--${boundary}\r\nContent-Type: application/gpx+xml\r\n\r\n`,
                gpx,
                `\r\n--${boundary}--`,
            ]);
        }
        const response = await this.request(
            `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=${uploadType}&fields=${FILE_FIELDS}&supportsAllDrives=true`,
            { method: 'PATCH', headers, body }
        );
        return (await response.json()) as DriveGPXFile;
    }

    async download(file: DriveGPXFile): Promise<File> {
        const response = await this.request(
            `${API}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
            { headers: this.resourceHeaders(file.id, file.resourceKey) }
        );
        const content = await response.blob();
        if (content.size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
        validateGPX(await content.text());
        return new File(
            [content],
            file.name.toLowerCase().endsWith('.gpx') ? file.name : `${file.name}.gpx`,
            { type: 'application/gpx+xml' }
        );
    }

    isManagedRoute(file: DriveGPXFile): boolean {
        return (
            file.isAppAuthorized === true &&
            file.appProperties?.trailExplorerRoute === '1' &&
            !!file.parents?.length
        );
    }

    async createShortShare(
        file: DriveGPXFile,
        view: unknown,
        publicURL: string,
        preview?: import('./route-preview').RoutePreview
    ): Promise<string> {
        const endpoint = new URL('/api/share', publicURL);
        const response = await this.request(endpoint.href, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'X-GPX-Share-Request': '1' },
            body: JSON.stringify({ id: file.id, resourceKey: file.resourceKey, view, preview }),
        });
        const result = (await response.json()) as { url?: string };
        const link = new URL(result.url || '', endpoint);
        if (
            link.origin !== endpoint.origin ||
            !/^\/s\/[a-zA-Z0-9_-]{16}$/.test(link.pathname) ||
            link.search ||
            link.hash
        )
            throw new Error('The short link service returned an invalid link.');
        return link.href;
    }

    async listFolders(parentId: string, pageToken?: string) {
        const parent = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const params = new URLSearchParams({
            q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents`,
            fields: `nextPageToken,files(${FILE_FIELDS})`,
            pageSize: '100',
            orderBy: 'name',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await this.request(`${API}?${params}`);
        return (await response.json()) as { files: DriveGPXFile[]; nextPageToken?: string };
    }

    async validateSaveFolder(id: string): Promise<DriveGPXFile> {
        // My Drive is a valid upload destination even when drive.file cannot read
        // its metadata. Keep the root alias; the upload still checks write access.
        if (id === 'root')
            return { id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder' };
        let folder: DriveGPXFile;
        try {
            folder = await this.getMetadata(id);
        } catch (e) {
            if (e instanceof Error && /GDrive error \((403|404)\)/.test(e.message))
                throw new Error('This folder is unavailable or GDrive has not granted access to it. Choose another folder, create one, or browse all GDrive folders.');
            throw e;
        }
        if (
            folder.trashed ||
            folder.mimeType !== 'application/vnd.google-apps.folder' ||
            folder.capabilities?.canAddChildren !== true
        )
            throw new Error(
                'This GDrive folder is unavailable or read-only. Choose another save folder.'
            );
        return folder;
    }

    async createFolder(name: string, parentId = 'root'): Promise<DriveGPXFile> {
        name = name.trim();
        if (!name || name.length > 200)
            throw new Error('Enter a folder name (up to 200 characters).');
        const response = await this.request(`${API}?fields=${FILE_FIELDS}&supportsAllDrives=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
                appProperties: { trailExplorerFolder: '1' },
            }),
        });
        return (await response.json()) as DriveGPXFile;
    }

    async upload(file: File, folderId?: string): Promise<DriveGPXFile> {
        if (!file.name.toLowerCase().endsWith('.gpx')) throw new Error('Choose a .gpx file');
        if (file.size > 30 * 1024 * 1024) throw new Error('GPX exceeds 30 MB limit');
        const text = await file.text();
        validateGPX(text);
        const metadata = {
            name: file.name,
            mimeType: 'application/gpx+xml',
            ...(folderId
                ? { parents: [folderId], appProperties: { trailExplorerRoute: '1' } }
                : {}),
        };
        const boundary = 'gpxstudio_' + crypto.randomUUID();
        const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
            JSON.stringify(metadata),
            `\r\n--${boundary}\r\nContent-Type: application/gpx+xml\r\n\r\n`,
            text,
            `\r\n--${boundary}--`,
        ]);
        const response = await this.request(
            `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
            {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body,
            }
        );
        return { ...((await response.json()) as DriveGPXFile), isAppAuthorized: true };
    }
}
