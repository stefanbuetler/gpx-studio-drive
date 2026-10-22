// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
    interface Window {
        _map?: import('maplibre-gl').Map;
    }
    namespace App {
        // interface Error {}
        // interface Locals {}
        // interface PageData {}
        // interface PageState {}
        // interface Platform {}
    }
}

export {};
