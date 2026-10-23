// Serve only the exact public endpoints needed for drawing tracks. Never forward
// browser cookies, authorization, arbitrary URLs, or upstream redirects.
export async function handleRoutingService(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let upstream: URL;
    let body: string | undefined;
    const headers = new Headers();
    if (url.pathname === '/__gpx_services/graphhopper/route') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
            return Response.json({ message: 'Expected a JSON routing request.' }, { status: 415 });
        }
        body = await request.text();
        if (body.length > 1024 * 1024) {
            return Response.json({ message: 'Routing request is too large.' }, { status: 413 });
        }
        headers.set('Content-Type', 'application/json');
        upstream = new URL('https://graphhopper.gpx.studio/route');
    } else {
        const tile = url.pathname.match(
            /^\/__gpx_services\/tiles\/mapterhorn\/(\d{1,2})\/(\d+)\/(\d+)\.webp$/
        );
        if (!tile) return new Response('Not found', { status: 404 });
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        const [, zoom, x, y] = tile.map(Number);
        if (zoom > 15 || x >= 2 ** zoom || y >= 2 ** zoom) {
            return new Response('Invalid elevation tile', { status: 400 });
        }
        upstream = new URL(`https://tiles.gpx.studio/mapterhorn/${zoom}/${x}/${y}.webp`);
    }
    try {
        const response = await fetch(upstream, {
            method: request.method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
        });
        if (response.status >= 300 && response.status < 400) {
            return Response.json({ message: 'Routing service returned an unexpected redirect. Please try again.' }, { status: 502 });
        }
        const resultHeaders = new Headers({
            'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'GET' && response.ok) {
            resultHeaders.set('Cache-Control', 'public, max-age=86400');
        }
        return new Response(response.body, { status: response.status, headers: resultHeaders });
    } catch {
        return Response.json(
            { message: 'Routing service could not be reached. Please try again.' },
            { status: 502 }
        );
    }
}
