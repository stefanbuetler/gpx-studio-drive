<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import { Button } from '$lib/components/ui/button';
    import { Cloud, HardDrive } from '@lucide/svelte';
    import {
        fileDestination,
        driveBrowserOpen,
        driveLocalActions,
        driveAccount,
    } from '$lib/drive/browser';
    import { triggerFileInput } from '$lib/logic/file-actions';
    import { exportFiles } from '$lib/components/export/utils.svelte';
    import { fileStateCollection } from '$lib/logic/file-state';
    import { getGPXName } from '$lib/logic/file-name';
    const request = $derived($fileDestination);
    const file = $derived(
        request?.localId ? fileStateCollection.getFile(request.localId) : undefined
    );
    async function device() {
        const current = request;
        fileDestination.set(null);
        // Open the native picker in the initiating user gesture.
        if (current?.mode === 'open') triggerFileInput();
        else if (current?.localId) await exportFiles([current.localId], []);
    }
    async function cloud() {
        const current = request;
        fileDestination.set(null);
        setTimeout(() => {
            if (current?.mode === 'open') driveBrowserOpen.set(true);
            else if (current?.localId) {
                $driveLocalActions[current.localId]?.saveAs?.();
            }
        }, 0);
    }
</script>

<Dialog.Root
    open={!!request}
    onOpenChange={(open) => {
        if (!open) fileDestination.set(null);
    }}
>
    <Dialog.Content class="sm:max-w-md">
        <Dialog.Header>
            <Dialog.Title>{request?.mode === 'open' ? 'Open' : 'Save as'}</Dialog.Title>
            <Dialog.Description
                >{request?.mode === 'open'
                    ? 'Where is your GPX file?'
                    : `Where would you like to save ${file ? getGPXName(file) : 'this route'}?`}</Dialog.Description
            >
        </Dialog.Header>
        <div class="grid gap-3">
            <Button variant="outline" class="h-auto justify-start gap-3 p-4" onclick={device}>
                <HardDrive class="size-5 shrink-0" />
                <span class="text-left"
                    ><span class="block font-medium">This device</span><span
                        class="block text-xs text-muted-foreground"
                        >{request?.mode === 'open'
                            ? 'Choose GPX files from your device'
                            : 'Download a GPX file to your device'}</span
                    ></span
                >
            </Button>
            <Button variant="outline" class="h-auto justify-start gap-3 p-4" onclick={cloud}>
                <Cloud class="size-5 shrink-0" />
                <span class="text-left"
                    ><span class="block font-medium">GDrive</span><span
                        class="block text-xs text-muted-foreground"
                        >{!$driveAccount
                            ? 'Connect GDrive to continue'
                            : request?.mode === 'open'
                              ? 'Browse your GPX files'
                              : 'Choose a folder and save a cloud copy'}</span
                    ></span
                >
            </Button>
        </div>
        <Dialog.Footer
            ><Button variant="outline" onclick={() => fileDestination.set(null)}>Cancel</Button
            ></Dialog.Footer
        >
    </Dialog.Content>
</Dialog.Root>
