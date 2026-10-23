import { get, writable } from 'svelte/store';

export const fileDestination = writable<{ mode: 'open' | 'save'; localId?: string } | null>(null);
export type CloudFile = { provider: 'gdrive'; account: string; remoteName: string; dirty: boolean };
export const cloudSaveStatus = writable<
    Record<string, { state: 'saving' | 'saved' | 'error'; message?: string }>
>({});
export const cloudCloseGuard = writable<(ids: string[]) => Promise<boolean>>(async () => true);
export const cloudFiles = writable<Record<string, CloudFile>>({});
export function saveOpenFile(id: string, asCopy = false) {
    const actions = get(driveLocalActions)[id];
    if (!asCopy && get(cloudFiles)[id]) actions?.save?.();
    else setTimeout(() => fileDestination.set({ mode: 'save', localId: id }), 0);
}
export const driveBrowserOpen = writable(false);
export const driveLocalActions = writable<
    Record<
        string,
        {
            busy: boolean;
            save?: () => void;
            share?: () => void;
            saveAs?: () => void;
            remoteName?: string;
        }
    >
>({});

export type DriveAccount = { displayName?: string; emailAddress?: string };
export const driveAccount = writable<DriveAccount | null>(null);
export const driveBatchActions = writable<{
    busy: boolean;
    disconnect?: () => void;
    saveAll?: (ids: string[]) => void;
    connect?: () => void;
}>({
    busy: false,
});

export function accountInitials(account: DriveAccount | null): string {
    const name = account?.displayName?.trim();
    const words = name?.split(/\s+/u).filter(Boolean) || [];
    if (words.length > 1)
        return (
            Array.from(words[0])[0] + Array.from(words[words.length - 1])[0]
        ).toLocaleUpperCase();
    const fallback = name || account?.emailAddress?.split('@')[0] || '';
    return Array.from(fallback).slice(0, 2).join('').toLocaleUpperCase() || 'G';
}
