import type { DriveGPXFile } from './client';
type SaveFolder = Pick<DriveGPXFile, 'id' | 'name'>;
const memory = new Map<string, SaveFolder>();
const key = (account: string) => `trail-explorer-save-folder:${account}`;
export function readSaveFolder(account: string): SaveFolder | undefined {
    try {
        const folder = JSON.parse(localStorage.getItem(key(account)) || 'null');
        if (typeof folder?.id === 'string' && typeof folder?.name === 'string') return folder;
    } catch {
        /* Fall back to the current session when browser storage is blocked. */
    }
    return memory.get(account);
}
export function writeSaveFolder(account: string, folder: SaveFolder): boolean {
    memory.set(account, folder);
    try {
        localStorage.setItem(key(account), JSON.stringify({ id: folder.id, name: folder.name }));
        return true;
    } catch {
        return false;
    }
}
