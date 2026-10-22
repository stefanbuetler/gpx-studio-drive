import Dexie, { type Table } from 'dexie';
import { db } from '$lib/db';
import type { DriveGPXFile } from './client';

export type SavedRoute = {
    key: string;
    account: string;
    localId: string;
    identity: string;
    folderId: string;
    remote: DriveGPXFile;
    hash: string;
};
const database = new Dexie('TrailExplorerSavedRoutes');
database.version(1).stores({ routes: '&key,account' });
const routes: Table<SavedRoute, string> = database.table('routes');
const memory = new Map<string, SavedRoute>();

export async function localSaveIdentity(localId: string): Promise<string> {
    // Keep the identity with the working copy, outside undo history. A reused
    // local ID or a duplicated file must never overwrite a different route.
    return db.transaction('rw', db.files, async () => {
        const file = await db.files.get(localId);
        if (!file) throw new Error('Local working copy not available');
        if (typeof file._data?.driveIdentity === 'string') return file._data.driveIdentity;
        const identity = crypto.randomUUID();
        await db.files.update(localId, { '_data.driveIdentity': identity });
        return identity;
    });
}

export function savedRouteKey(account: string, localId: string, identity: string) {
    return `${account}:${localId}:${identity}`;
}

export async function readSavedRoute(key: string): Promise<SavedRoute | undefined> {
    try {
        const saved = await routes.get(key);
        if (saved?.remote?.id && saved.folderId && saved.hash) return saved;
    } catch {
        /* In-memory links still work when optional storage is blocked. */
    }
    return memory.get(key);
}

export async function writeSavedRoute(saved: SavedRoute): Promise<boolean> {
    memory.set(saved.key, saved);
    try {
        await routes.put(saved);
        return true;
    } catch {
        return false;
    }
}

export async function contentHash(content: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
