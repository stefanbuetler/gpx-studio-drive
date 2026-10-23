<script lang="ts">
    import { PUBLIC_MAPTILER_KEY } from '$env/static/public';
    import { page } from '$app/state';
    import { onMount } from 'svelte';
    import Embedding from '$lib/components/embedding/Embedding.svelte';
    import {
        getMergedEmbeddingOptions,
        type EmbeddingOptions,
    } from '$lib/components/embedding/embedding';

    let embeddingOptions = $state<EmbeddingOptions>();
    let error = $state('');

    onMount(() => {
        try {
            const raw = page.url.searchParams.get('options');
            if (!raw) return;
            const options = JSON.parse(raw);
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new Error('Invalid options');
            embeddingOptions = getMergedEmbeddingOptions({ key: PUBLIC_MAPTILER_KEY, ...options });
        } catch {
            error = 'This embed has invalid view settings.';
        }
    });
</script>

{#if error}<p role="alert">{error}</p>{:else if embeddingOptions}
    <Embedding
        options={embeddingOptions}
        hash={page.url.hash}
        useHash={page.url.searchParams.get('fit') !== 'route'}
    />
{/if}
