import { sveltekit } from '@sveltejs/kit/vite';
import { enhancedImages } from '@sveltejs/enhanced-img';
import { defineConfig } from 'vite';
import { serviceHosts } from './src/lib/service-url';
import tailwindcss from '@tailwindcss/vite';
import { driveSessionDevPlugin } from './dev-drive-session';

export default defineConfig({
    envPrefix: ['VITE_', 'PUBLIC_'],
    server: {
        proxy: {
            '/api/pois': {
                target: 'https://overpass.gpx.studio',
                changeOrigin: true,
                rewrite: (path: string) => path.replace('/api/pois', '/api/interpreter'),
            },
            ...Object.fromEntries(
                Object.entries(serviceHosts).map(([name, target]) => [
                    `/__gpx_services/${name}/`,
                    {
                        target,
                        changeOrigin: true,
                        rewrite: (path: string) => path.replace(`/__gpx_services/${name}`, ''),
                    },
                ])
            ),
        },
    },
    ssr: {
        noExternal: ['gpx'],
    },
    plugins: [driveSessionDevPlugin(), enhancedImages(), tailwindcss(), sveltekit()],
});
