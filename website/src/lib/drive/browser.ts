import { writable } from 'svelte/store';

export const driveFolderOpen = writable(false);
export const driveBrowserOpen = writable(false);
export const driveLocalActions = writable<
    Record<
        string,
        {
            busy: boolean;
            save?: () => void;
            share?: () => void;
        }
    >
>({});

export type DriveAccount = { displayName?: string; emailAddress?: string };
export const driveAccount = writable<DriveAccount | null>(null);
export const driveBatchActions = writable<{
    busy: boolean;
    saveAll?: () => void;
    disconnect?: () => void;
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
