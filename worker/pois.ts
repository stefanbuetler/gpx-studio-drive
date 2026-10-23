// Fixed upstream: never accepts a destination URL or forwards user credentials.
export async function handlePOIs(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const query = new URL(request.url).searchParams.get('data');
    if (
        !query ||
        query.length > 16000 ||
        !query.startsWith('[timeout:20][bbox:') ||
        !/^\[timeout:20\]\[bbox:-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+\]\[out:json\];\((?:nwr(?:\[[\w:]+=[\w:.-]+\])+;)+\);out center;$/.test(
            query
        )
    ) {
        return new Response('Invalid POI query', { status: 400 });
    }
    try {
        const url = new URL('https://overpass.gpx.studio/api/interpreter');
        url.searchParams.set('data', query);
        const upstream = await fetch(url, {
            signal: AbortSignal.timeout(25000),
            headers: { Accept: 'application/json' },
            redirect: 'manual',
        });
        if (!upstream.ok) return new Response('POI service unavailable', { status: 502 });
        const result = (await upstream.json()) as { elements?: unknown[]; remark?: string };
        if (!Array.isArray(result.elements) || result.remark) {
            return new Response('Incomplete POI response', { status: 502 });
        }
        return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=300' } });
    } catch {
        return new Response('POI service unavailable', { status: 502 });
    }
}
