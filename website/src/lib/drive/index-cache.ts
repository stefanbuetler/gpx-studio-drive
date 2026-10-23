import Dexie, { type Table } from 'dexie';
import type { DriveIndex } from './client';

const database = new Dexie('TrailExplorerDriveIndex');
database.version(1).stores({ indexes: '&key' });
const indexes: Table<DriveIndex & { key: string }, string> = database.table('indexes');

export async function readDriveIndex(key: string): Promise<DriveIndex | undefined> {
    try {
        const value = await indexes.get(key);
        if (
            value &&
            Array.isArray(value.files) &&
            value.files.every(
                (file) => file && typeof file.id === 'string' && typeof file.name === 'string'
            ) &&
            value.tokens &&
            typeof value.tokens.user === 'string' &&
            value.tokens.user.length > 0 &&
            Object.values(value.tokens).every(
                (token) => typeof token === 'string' && token.length > 0
            ) &&
            Number.isFinite(value.updatedAt)
        )
            return value;
    } catch {
        /* Storage can be unavailable; live Drive browsing still works. */
    }
}

export async function writeDriveIndex(key: string, index: DriveIndex): Promise<boolean> {
    try {
        await indexes.put({
            key,
            files: index.files,
            tokens: index.tokens,
            updatedAt: index.updatedAt,
        });
        return true;
    } catch {
        return false;
    }
}

export async function clearDriveIndexes(): Promise<void> {
    try {
        await indexes.clear();
    } catch {
        /* No persisted index to clear. */
    }
}
