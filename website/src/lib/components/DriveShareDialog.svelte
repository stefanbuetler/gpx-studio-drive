<script lang="ts">
    import { iframeCode } from '$lib/drive/sharing';
    import * as Dialog from '$lib/components/ui/dialog';
    import { Button } from '$lib/components/ui/button';
    import type { DriveGPXFile } from '$lib/drive/client';
    let {
        open = $bindable(false),
        file,
        onshare,
    }: {
        open: boolean;
        file: DriveGPXFile;
        onshare: (file: DriveGPXFile) => Promise<string>;
    } = $props();
    let busy = $state(false);
    let link = $state('');
    let error = $state('');
    let notice = $state('');
    async function publish() {
        busy = true;
        error = '';
        try {
            link = await onshare(file);
        } catch (e) {
            error = e instanceof Error ? e.message : 'Could not create the public link.';
        } finally {
            busy = false;
        }
    }
    let embed = $derived(link ? iframeCode(link) : '');
    async function copy(value: string, label: string) {
        try {
            await navigator.clipboard.writeText(value);
            notice = `${label} copied`;
        } catch {
            notice = 'Select the text above and copy it manually.';
        }
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content
        class="max-h-[90dvh] overflow-y-auto"
        showCloseButton={!busy}
        onEscapeKeydown={(event) => {
            if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
            if (busy) event.preventDefault();
        }}
    >
        <Dialog.Header>
            <Dialog.Title>Share route</Dialog.Title>
            <Dialog.Description>{file.name}</Dialog.Description>
        </Dialog.Header>
        {#if !link}
            <p>
                Anyone with this link will be able to view and download this GPX file without
                signing in. They cannot overwrite your original through the link.
            </p>
            <p class="text-sm text-muted-foreground">
                Your local route will be saved to your chosen GDrive folder first. Only that saved
                copy will be shared. Future saves to it will appear at the same link.
            </p>
            <p class="text-sm text-muted-foreground">
                The link and embed will use your current map layer, overlays, markers, units, theme,
                and elevation display. The route will be centered automatically. Custom map layer
                URLs are included, so use public tile sources. A route image is included in
                messaging previews.
            </p>
            <p class="text-sm text-muted-foreground">
                You can turn off link sharing in GDrive. Downloaded copies and cached messaging
                previews may remain with their recipients.
            </p>
            <Dialog.Footer>
                <Button variant="outline" disabled={busy} onclick={() => (open = false)}
                    >Cancel</Button
                >
                <Button disabled={busy} onclick={publish}
                    >{busy ? 'Creating public link…' : 'Make public and create link'}</Button
                >
            </Dialog.Footer>
        {:else}
            <img
                src="{link}/image.jpg"
                alt="Preview map of {file.name}"
                class="w-full rounded-md border aspect-[1200/630] object-cover"
            />
            <label class="text-sm font-medium" for="public-route-link">Public route link</label>
            <input
                id="public-route-link"
                class="w-full border rounded px-2 py-2 bg-background"
                readonly
                value={link}
                onclick={(event) => event.currentTarget.select()}
            />
            <div class="flex gap-2">
                <Button onclick={() => copy(link, 'Link')}>Copy link</Button>
                <Button variant="outline" href={link} target="_blank" rel="noopener noreferrer"
                    >Open viewer</Button
                >
            </div>
            <label class="text-sm font-medium mt-2" for="route-embed-code">Embed code</label>
            <textarea
                id="route-embed-code"
                class="w-full min-h-28 border rounded px-2 py-2 bg-background font-mono text-xs break-all"
                readonly
                value={embed}
                onclick={(event) => event.currentTarget.select()}
            ></textarea>
            <div class="flex gap-2 flex-wrap">
                <Button variant="outline" onclick={() => copy(embed, 'Embed code')}
                    >Copy embed code</Button
                >
            </div>
            <p class="text-xs text-muted-foreground">
                Paste into your website's HTML. Adjust the height as needed; the map fits the route
                to the available space. Both formats preserve the view settings captured when
                shared.
            </p>
            <p class="text-sm">Anyone with the link can now view this route.</p>
        {/if}
        {#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
        {#if notice}<p class="text-sm" role="status">{notice}</p>{/if}
    </Dialog.Content>
</Dialog.Root>
