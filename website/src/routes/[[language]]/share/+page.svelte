<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/state';
    import { PUBLIC_MAPTILER_KEY } from '$env/static/public';
    import Embedding from '$lib/components/embedding/Embedding.svelte';
    import {
        getMergedEmbeddingOptions,
        type EmbeddingOptions,
    } from '$lib/components/embedding/embedding';
    let options = $state<EmbeddingOptions>();
    let error = $state('');
    onMount(() => {
        try {
            const id = page.url.searchParams.get('id');
            const resourceKey = page.url.searchParams.get('resourcekey');
            if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
                error = 'This route link is incomplete or invalid. Ask the sender for a new link.';
                return;
            }
            const view = JSON.parse(page.url.searchParams.get('view') || '{}');
            options = getMergedEmbeddingOptions({
                ...view,
                files: [],
                ids: [id],
                resourceKeys: resourceKey ? { [id]: resourceKey } : {},
                key: PUBLIC_MAPTILER_KEY,
            });
        } catch {
            error = 'This route link has invalid view settings. Ask the sender for a new link.';
        }
    });
</script>

<svelte:head
    ><title>Shared route — trail-explorer</title><meta
        name="robots"
        content="noindex"
    /></svelte:head
>
{#if error}<main class="p-8">
        <h1 class="text-xl font-semibold mb-3">Shared route</h1>
        <p role="alert">{error}</p>
    </main>
{:else if options}<main class="fixed inset-0" aria-label="Shared route viewer">
        <Embedding {options} hash="" useHash={false} />
    </main>{/if}
