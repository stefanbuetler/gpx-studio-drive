import { sveltekit } from '@sveltejs/kit/vite';
import { enhancedImages } from '@sveltejs/enhanced-img';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    envPrefix: ['VITE_', 'PUBLIC_'],
    ssr: {
        noExternal: ['gpx'],
    },
    plugins: [enhancedImages(), tailwindcss(), sveltekit()],
});
